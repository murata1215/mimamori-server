/**
 * Webhook 受信。
 *
 * - RevenueCat: エンタイトルメント同期（個人課金）
 * - SwitchBot: Phase 2。アダプタ規約の実証エンドポイント
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { ingestEvents } from '../engine/events.js';
import { resolveSensor, touchSensor } from '../engine/sensor-registry.js';
import { audit } from '../lib/audit.js';

/**
 * RevenueCat Webhook のペイロード（必要な部分のみ）。
 * 全フィールドを厳密に定義すると RevenueCat 側の仕様追加で壊れるため、
 * 判定に使うフィールドだけを取り出す。
 */
const revenueCatSchema = z.object({
  event: z.object({
    type: z.string(),
    app_user_id: z.string(),
    entitlement_ids: z.array(z.string()).nullish(),
  }),
});

/** SwitchBot Webhook のペイロード（Phase 2） */
const switchBotSchema = z.object({
  eventType: z.string(),
  context: z.object({
    deviceMac: z.string(),
    /** 人感センサー: 'DETECTED' | 'NOT_DETECTED' */
    detectionState: z.string().optional(),
    /** 開閉センサー: 'open' | 'close' | 'timeOutNotClose' */
    openState: z.string().optional(),
    /** スマートプラグ: 消費電力(W) */
    weight: z.number().optional(),
    /** スマートプラグ: 'ON' | 'OFF' */
    powerState: z.string().optional(),
    /** 発生時刻（epoch ms） */
    timeOfSample: z.number().optional(),
  }),
});

/**
 * 電力メーター（Bルート/電力会社API）連携のペイロード（Phase 2, spec 8）。
 *
 * Bルートは30分ごとに確定値を出す。それを中継するゲートウェイから受ける想定。
 *
 * 【confidence を受け取らない】
 * 送信側が信頼度を自己申告できてはならない。信頼度はソース種別から
 * サーバーが決める（sources.ts）。
 */
const powerMeterSchema = z.object({
  /** 供給地点特定番号など、登録済みの識別子 */
  meter_id: z.string().min(1).max(200),
  /** 30分値（Wh）。閾値超過の判定は送信側ではなくサーバーが行う。 */
  watt_hours: z.number().nonnegative(),
  /** 計測時刻（ISO8601） */
  measured_at: z.string().datetime(),
});

/**
 * 電力の30分値を「活動あり」とみなす下限（Wh）。
 *
 * 【この値の意味と限界】
 * 家全体の30分値には冷蔵庫・給湯器・待機電力が常に含まれる。
 * 現状は「ベースラインを明らかに超えた消費があったか」を固定値で近似している。
 * 本来は世帯ごとのベースラインを学習して差分を見るべきで、それをしない限り
 * この値は「本人が動いた」の証拠として弱い。
 * だからこそ power_meter は confidence 70（弱シグナル）に置かれており、
 * これ単体では ALIVE 復帰を起こさない。判定を鈍らせるのは
 * クロス判定の保留時間（上限つき）までに限定されている。
 *
 * TODO(Phase 2+): 世帯ごとのベースライン学習（doc/issues.md）。
 */
const POWER_ACTIVITY_MIN_WH = 300;

/**
 * 定数時間で文字列を比較する。
 *
 * Webhook の署名検証で通常の === を使うと、比較の早期リターンにより
 * タイミング攻撃で署名を1バイトずつ特定されうる。
 *
 * @param a - 比較対象1
 * @param b - 比較対象2
 * @returns 一致すれば true
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // 長さが違うと timingSafeEqual は例外を投げる。
  // 長さの相違自体は秘密ではないので先に返してよい。
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 外部から渡された発生時刻を安全な範囲へ丸める。
 *
 * 【なぜ必要か】
 * 外部デバイスの時計を信用して未来時刻を受け入れると、
 * last_alive_event_at が未来になり「経過時間が永久にマイナス」＝
 * 二度と閾値を超えない = デッドマンスイッチが停止する。
 * 端末のハートビート（device.ts）と同じ理由で、ここでも必ず丸める。
 *
 * 過去方向も同様に制限する。極端に古い occurred_at は
 * パーティション範囲外へ落ちる（events_default 行き）ため、受信時刻へ寄せる。
 *
 * @param epochMs - 発生時刻（epoch ms）。未指定・不正なら受信時刻を使う
 * @returns 丸めた発生時刻
 */
function clampOccurredAt(epochMs: number | undefined): Date {
  const now = Date.now();
  if (epochMs === undefined || !Number.isFinite(epochMs)) return new Date(now);

  // 未来 → 受信時刻へ
  if (epochMs > now) return new Date(now);

  // 過去7日より古い → 受信時刻へ。
  // センサーのイベントがそこまで遅れて届くことは正常系では起きない。
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  if (now - epochMs > SEVEN_DAYS_MS) return new Date(now);

  return new Date(epochMs);
}

/**
 * SwitchBot のイベントが「人の行動」を示すかを判定する。
 *
 * 【判定根拠】
 * - openState 'open'/'close': ドアは人が動かさないと開閉しない。両方とも行動。
 *   'timeOutNotClose'（開けっ放し警告）は状態の通知であって新たな行動ではない。
 * - detectionState 'DETECTED': 人感センサーの検知。行動。
 * - powerState 'ON': 誰かがプラグの家電を入れた。行動。
 *   'OFF' は消し忘れのタイマー等でも起きうるが、人が消した可能性が高いので採用する。
 *
 * 【weight（消費電力）を採用しない理由】
 * プラグは家電に挿しっぱなしなので weight > 0 は「家電が動いている」でしかなく、
 * 人の行動とは限らない（例: 冷蔵庫をプラグに挿した場合）。
 * spec 8 は「消費電力変化 → activity」と書いているが、変化の検出には
 * 前回値との比較が要る。現状の実装は状態遷移イベント（powerState）のみを採用し、
 * weight は判定に使わない。
 *
 * @param context - SwitchBot ペイロードの context
 * @returns 人の行動を示すなら true
 */
function isSwitchBotActivity(context: {
  detectionState?: string;
  openState?: string;
  powerState?: string;
}): boolean {
  if (context.openState === 'open' || context.openState === 'close') return true;
  if (context.detectionState === 'DETECTED') return true;
  if (context.powerState === 'ON' || context.powerState === 'OFF') return true;
  return false;
}

/**
 * Webhook ルートを登録する。
 *
 * @param app - fastify インスタンス
 */
export default async function webhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/webhooks/revenuecat — エンタイトルメント同期
   *
   * RevenueCat は Authorization ヘッダに設定値をそのまま載せてくる方式。
   * 未設定の場合は 503（誰でも課金状態を書き換えられる状態を作らない）。
   */
  app.post('/v1/webhooks/revenuecat', async (req, reply) => {
    if (!config.REVENUECAT_WEBHOOK_SECRET) {
      // シークレット未設定でwebhookを開けてはならない。
      // 「認証なしで通す」フォールバックは課金の不正操作を許す。
      app.log.error('REVENUECAT_WEBHOOK_SECRET が未設定のため webhook を拒否しました');
      return reply.code(503).send({ error: 'webhook_not_configured' });
    }

    const auth = req.headers.authorization;
    if (!auth || !safeEqual(auth, config.REVENUECAT_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = revenueCatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const { type, app_user_id, entitlement_ids } = parsed.data.event;

    // app_user_id には watcher_id を設定する運用（アプリ側で Purchases.logIn する）
    const watcherId = app_user_id;
    if (!z.string().uuid().safeParse(watcherId).success) {
      app.log.warn({ app_user_id }, 'app_user_id が watcher_id 形式ではありません');
      return reply.code(202).send({ ok: true, ignored: true });
    }

    // エンタイトルメント有効化イベント → ownerプランへ
    // 失効イベント → freeへ戻す
    const activeTypes = ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION'];
    const inactiveTypes = ['CANCELLATION', 'EXPIRATION', 'SUBSCRIPTION_PAUSED', 'BILLING_ISSUE'];

    let plan: string | null = null;
    if (activeTypes.includes(type) && (entitlement_ids?.length ?? 0) > 0) {
      plan = 'owner';
    } else if (inactiveTypes.includes(type)) {
      plan = 'free';
    }

    if (plan) {
      const res = await query('UPDATE watchers SET plan = $2 WHERE id = $1', [watcherId, plan]);
      await audit(null, 'notification_sent', {
        kind: 'revenuecat_sync',
        watcher_id: watcherId,
        event_type: type,
        plan,
        updated: (res.rowCount ?? 0) > 0,
      });
    }

    // RevenueCat は 2xx 以外だとリトライし続ける。
    // 処理対象外のイベントでも 200 を返す。
    return reply.send({ ok: true });
  });

  /**
   * POST /v1/webhooks/switchbot — SwitchBot アダプタ（Phase 2 で有効化済み）
   *
   * 【このエンドポイントの意義】(spec 8)
   * 「アダプタ実装のみで判定エンジン無改修」を実証するエンドポイント。
   * ここがやるのは "SwitchBotのイベント → 共通イベントへの正規化 → ingestEvents"
   * だけであり、判定エンジン・状態遷移・学習・通知には一切触れていない。
   *
   * 実際に Phase 2 で追加した判定エンジン側の変更はゼロ件だった
   * （クロス判定は spec 5.2 が Phase 2 の判定仕様として最初から定めていたもので、
   * ソース追加に伴う改修ではない）。抽象化は成立している。
   */
  app.post('/v1/webhooks/switchbot', async (req, reply) => {
    if (!config.SWITCHBOT_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'webhook_not_configured' });
    }

    // --- 署名検証（必須） ---
    // SwitchBot は t(timestamp) + nonce + sign ヘッダで HMAC-SHA256 署名を送る。
    const sign = req.headers['sign'] as string | undefined;
    const t = req.headers['t'] as string | undefined;
    const nonce = (req.headers['nonce'] as string | undefined) ?? '';

    if (!sign || !t) {
      return reply.code(401).send({ error: 'missing_signature' });
    }

    // リプレイ攻撃対策: 5分以上古いリクエストは拒否する
    const ts = Number(t);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      return reply.code(401).send({ error: 'stale_signature' });
    }

    const expected = createHmac('sha256', config.SWITCHBOT_WEBHOOK_SECRET)
      .update(`${config.SWITCHBOT_WEBHOOK_SECRET}${t}${nonce}`)
      .digest('base64');

    if (!safeEqual(sign, expected)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const parsed = switchBotSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const { context } = parsed.data;

    // --- デバイス → クライアントの逆引き ---
    const sensor = await resolveSensor(context.deviceMac);
    if (!sensor) {
      // 未登録 or 無効化済み。署名は正しいので攻撃ではなく設定漏れの可能性が高い。
      // 【注意】登録済みか否かで応答を変えても、SwitchBot のシークレットを
      // 持つ者にしか到達できないため情報漏洩にはならない。
      app.log.warn({ deviceMac: context.deviceMac }, '未登録のSwitchBotデバイスからのイベント');
      return reply.code(404).send({ error: 'unknown_device' });
    }

    // --- 正規化: SwitchBot のイベント → 共通イベント ---
    if (!isSwitchBotActivity(context)) {
      // 状態変化ではあるが、人の行動を示さないもの（'close' でない NOT_DETECTED 等）。
      // 受け取ったこと自体は成功として返す（SwitchBot にリトライさせない）。
      return reply.send({ ok: true, ignored: true });
    }

    const occurredAt = clampOccurredAt(context.timeOfSample);

    // 【アダプタ規約の実証点】(spec 8)
    // このアダプタがやったのはここまで — 逆引きと正規化だけ。
    // ingestEvents から先（状態遷移・閾値学習・通知）は Phase 1 のコードが
    // 一切の改修なしにそのまま動く。
    await ingestEvents([
      {
        clientId: sensor.clientId,
        // 登録時に確定した種別を使う（ペイロードから推測しない。sensor-registry.ts 参照）
        sourceType: sensor.sourceType,
        sourceId: context.deviceMac,
        eventType: 'activity',
        occurredAt,
        confidence: sensor.confidence,
        // 【禁止】meta に行動詳細を入れない。
        // openState('open'/'close') を入れると「いつ玄関が開いたか」が
        // events に残り、原則1・原則3に反する。判定に不要な情報は保存しない。
        meta: {},
      },
    ]);

    await touchSensor(sensor.id, occurredAt);

    return reply.send({ ok: true });
  });

  /**
   * POST /v1/webhooks/power-meter — 電力Bルート/電力会社API アダプタ（Phase 2, spec 8）
   *
   * 30分値の変動を activity として取り込む。
   * ただし confidence 70 の低信頼ソースであり、これ単体では ALIVE 復帰しない
   * （冷蔵庫が住人の生存を証明し続ける事態を防ぐため。sources.ts 参照）。
   */
  app.post('/v1/webhooks/power-meter', async (req, reply) => {
    if (!config.POWER_METER_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'webhook_not_configured' });
    }

    const auth = req.headers.authorization;
    if (!auth || !safeEqual(auth, config.POWER_METER_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const parsed = powerMeterSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const { meter_id, watt_hours, measured_at } = parsed.data;

    const sensor = await resolveSensor(meter_id);
    if (!sensor) return reply.code(404).send({ error: 'unknown_device' });

    // ベースライン以下の消費は「誰も動いていない家」でも発生する。
    // 活動として扱わない。
    if (watt_hours < POWER_ACTIVITY_MIN_WH) {
      return reply.send({ ok: true, ignored: true });
    }

    const occurredAt = clampOccurredAt(Date.parse(measured_at));

    await ingestEvents([
      {
        clientId: sensor.clientId,
        sourceType: sensor.sourceType,
        sourceId: meter_id,
        eventType: 'activity',
        occurredAt,
        // 弱シグナル。ingestEvent 側が last_alive_event_at ではなく
        // last_weak_signal_at を更新する。
        confidence: sensor.confidence,
        meta: {},
      },
    ]);

    await touchSensor(sensor.id, occurredAt);

    return reply.send({ ok: true });
  });
}
