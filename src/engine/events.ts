/**
 * イベント投入層（原則4「スマホは数あるセンサーの一つ」の実装点）。
 *
 * 【アダプタ規約】(spec 8)
 * 新しいソース（SwitchBot、電力メーター等）を追加する際は、
 * 「Webhook/ポーリング → ingestEvent() の呼び出し」だけを実装する。
 * 判定エンジン・状態遷移・学習・通知は無改修であること。
 * 改修が必要になった時点でアダプタ設計の失敗とみなす。
 *
 * このモジュールが全ソース共通の入口であり、ここで
 *   1. events への正規化挿入
 *   2. 生存イベントなら clients の非正規化カラム更新 ＋ 即 ALIVE 復帰
 * を単一トランザクションで行う。
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { isHighConfidence } from './sources.js';
import type { ClientStatus } from './state.js';

/** イベント種別 */
export type EventType = 'heartbeat' | 'activity' | 'sos' | 'confirm_alive' | 'source_silent';

/** 投入するイベント */
export interface IngestEvent {
  clientId: string;
  sourceType: string;
  sourceId?: string | null;
  eventType: EventType;
  /** 発生時刻。端末キュー再送でも元の時刻を保持すること。 */
  occurredAt: Date;
  /** 0-100。将来の低信頼ソース用（例: 電力30分値は70程度）。 */
  confidence?: number;
  /**
   * 付随情報。
   * 【禁止】行動詳細（アプリ名・URL）・位置情報を入れてはならない。
   * 入れてよいのは battery_level / screen_on_count / had_app_usage 等、
   * 「本人が生きているか」の判定に必要な値のみ。
   */
  meta?: Record<string, unknown>;
}

/**
 * イベントが「本人が生きている」ことを示すかを判定する。
 *
 * 【この関数がプロダクトの根幹】(spec 5.1)
 * heartbeat は「端末が生きている」ことしか示さない。
 * screen_on_count > 0 または had_app_usage = true の場合にのみ
 * 「本人が生きている」= 生存イベントとして扱う。
 *
 * 全て0のheartbeatは「端末は生きているが操作なし」であり、
 * 経過時間のカウントは継続する。ここを混同すると、
 * 充電器に挿さったまま持ち主が倒れている端末を「生存」と誤判定する。
 *
 * 【Phase 2 で追加した confidence の判定】
 * spec 5.1 の生存イベント定義は event_type しか見ていないが、これを額面どおり
 * 実装すると spec 8 の「電力30分値は低信頼ソース」が意味を持たなくなり、
 * 冷蔵庫の稼働が本人の生存を証明し続けてデッドマンスイッチが永久に発報しなくなる。
 * よって activity は confidence が HIGH_CONFIDENCE_MIN 以上の場合のみ生存イベントとする。
 * 判断の根拠は 003_sensors.sql と sources.ts のコメントに詳述。
 *
 * @param e - 判定対象のイベント
 * @returns 生存イベントなら true
 */
export function isAliveEvent(e: IngestEvent): boolean {
  // 本人が明示的にタップした確認。ソースを問わず最も強い証拠。
  if (e.eventType === 'confirm_alive') return true;

  // activity は「誰か/何かが動いた」でしかない。それが本人だと言い切れる
  // ソースからのものかを confidence で判別する。
  if (e.eventType === 'activity') return isHighConfidence(e.confidence ?? 100);

  if (e.eventType === 'heartbeat') {
    const meta = e.meta ?? {};
    const screenOn = Number(meta.screen_on_count ?? 0);
    const hadUsage = meta.had_app_usage === true;
    const hadMovement = meta.had_movement === true;
    return screenOn > 0 || hadUsage || hadMovement;
  }

  // sos は生存イベントではない（SOSは別状態であり、ALIVE復帰させてはならない）
  // source_silent も当然生存ではない
  return false;
}

/**
 * イベントが「弱シグナル」かを判定する（Phase 2）。
 *
 * 弱シグナル = 低信頼ソースからの activity。
 * 「誰かが/何かが動いた形跡はあるが、本人の行動とは言い切れない」もの。
 *
 * 経過時間はリセットしない（= 生存の証明にはしない）が、
 * 「端末が沈黙していて本人確認を届けられない」状況において、
 * ALERT の発報を一定時間だけ保留する材料として使う（クロス判定。spec 5.2）。
 *
 * @param e - 判定対象のイベント
 * @returns 弱シグナルなら true
 */
export function isWeakSignal(e: IngestEvent): boolean {
  return e.eventType === 'activity' && !isHighConfidence(e.confidence ?? 100);
}

/** イベント投入の結果 */
export interface IngestResult {
  /** 実際に挿入されたか（重複再送で無視された場合 false） */
  inserted: boolean;
  /** 生存イベントとして扱われたか */
  wasAliveEvent: boolean;
  /** ALIVE へ復帰したか */
  revivedToAlive: boolean;
  /** 復帰前の状態 */
  previousStatus?: ClientStatus;
}

/**
 * イベントを1件投入する。
 *
 * @param e - 投入するイベント
 * @param tx - 既存トランザクション（省略時は新規作成）
 * @returns 投入結果
 */
export async function ingestEvent(e: IngestEvent, tx?: PoolClient): Promise<IngestResult> {
  const run = async (client: PoolClient): Promise<IngestResult> => {
    // --- 1. events へ正規化挿入 ---
    // ON CONFLICT DO NOTHING: 端末のローカルキュー再送で同一イベントが
    // 複数回届いても冪等に処理する。
    const insertRes = await client.query(
      `INSERT INTO events (client_id, source_type, source_id, event_type, occurred_at, confidence, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_id, source_type, event_type, occurred_at) DO NOTHING
       RETURNING id`,
      [
        e.clientId,
        e.sourceType,
        e.sourceId ?? null,
        e.eventType,
        e.occurredAt,
        e.confidence ?? 100,
        JSON.stringify(e.meta ?? {}),
      ],
    );

    const inserted = (insertRes.rowCount ?? 0) > 0;
    const alive = isAliveEvent(e);

    // 重複再送は状態を動かさない（同じイベントで二度復帰させない）
    if (!inserted) {
      return { inserted: false, wasAliveEvent: alive, revivedToAlive: false };
    }

    // --- 2. heartbeat なら端末生存時刻を更新 ---
    // 操作の有無に関わらず、heartbeat が届いた事実は last_heartbeat_at に記録する。
    // これが「端末沈黙」の判定材料になる。
    if (e.eventType === 'heartbeat') {
      await client.query(
        `UPDATE clients
            SET last_heartbeat_at = GREATEST(COALESCE(last_heartbeat_at, $2), $2)
          WHERE id = $1`,
        [e.clientId, e.occurredAt],
      );
    }

    // --- 2b. 弱シグナルはクロス判定用に退避（Phase 2） ---
    // 【重要】ここで last_alive_event_at を更新してはならない。
    // 更新した瞬間、冷蔵庫の稼働が本人の生存を証明し続ける状態になり、
    // デッドマンスイッチが二度と発報しなくなる（003_sensors.sql のコメント参照）。
    if (isWeakSignal(e)) {
      await client.query(
        `UPDATE clients
            SET last_weak_signal_at = GREATEST(COALESCE(last_weak_signal_at, $2), $2)
          WHERE id = $1`,
        [e.clientId, e.occurredAt],
      );
    }

    if (!alive) {
      return { inserted: true, wasAliveEvent: false, revivedToAlive: false };
    }

    // --- 3. 生存イベント: 即 ALIVE 復帰 ---
    // 【重要】SOS状態からは自動復帰させない。
    // SOSは本人の明示的な意思表示であり、ウォッチャーの手動resolveでのみ解除される
    // （spec 5.2「生存イベント受信 → 即ALIVE。SOSのみ手動resolve必須」）。
    //
    // GREATEST(...) を使うのは、キュー再送で古いイベントが後から届いた場合に
    // last_alive_event_at を過去へ巻き戻さないため。
    //
    // 更新前の状態を UPDATE ... RETURNING のサブクエリで取ろうとしてはならない。
    // RETURNING 内のサブクエリがどのスナップショットを見るかは直感に反するため、
    // 「復帰したか」の判定は SELECT で明示的に先読みする。
    const before = await client.query<{ status: ClientStatus }>(
      'SELECT status FROM clients WHERE id = $1 FOR UPDATE',
      [e.clientId],
    );
    const previousStatus = before.rows[0]?.status;
    if (!previousStatus) {
      return { inserted: true, wasAliveEvent: true, revivedToAlive: false };
    }

    // SOS状態のクライアントは状態も付随フラグも一切触らない
    if (previousStatus === 'SOS') {
      await client.query(
        `UPDATE clients SET last_alive_event_at = GREATEST(last_alive_event_at, $2) WHERE id = $1`,
        [e.clientId, e.occurredAt],
      );
      return {
        inserted: true,
        wasAliveEvent: true,
        revivedToAlive: false,
        previousStatus,
      };
    }

    // GREATEST(...) を使うのは、キュー再送で古いイベントが後から届いた場合に
    // last_alive_event_at を過去へ巻き戻さないため。
    //
    // 状態に付随するフラグ（confirming_since 等）は復帰時に必ずクリアする。
    // 消し忘れると、次に CONFIRMING へ入った時に古い confirming_since が残っており
    // 即座に ALERT へ飛ぶ（＝重大な誤報）。
    await client.query(
      `UPDATE clients
          SET last_alive_event_at = GREATEST(last_alive_event_at, $2),
              status = 'ALIVE',
              status_changed_at = CASE WHEN status <> 'ALIVE' THEN now() ELSE status_changed_at END,
              confirming_since = NULL,
              last_alert_notified_at = NULL,
              silent_push_sent_at = NULL
        WHERE id = $1`,
      [e.clientId, e.occurredAt],
    );

    return {
      inserted: true,
      wasAliveEvent: true,
      revivedToAlive: previousStatus !== 'ALIVE',
      previousStatus,
    };
  };

  return tx ? run(tx) : withTransaction(run);
}

/**
 * 複数イベントをまとめて投入する（ハートビートのバッチ受付用）。
 *
 * 端末はオフライン時にローカルキューへ蓄積し、復帰時にまとめて送る。
 * 全件を単一トランザクションで処理し、1件の失敗で全体を巻き戻す。
 * （部分的に成功すると last_alive_event_at が中途半端な値になる）
 *
 * @param events - 投入するイベント（時系列順である必要はない）
 * @returns 各イベントの投入結果
 */
export async function ingestEvents(events: IngestEvent[]): Promise<IngestResult[]> {
  if (events.length === 0) return [];

  return withTransaction(async (client) => {
    const results: IngestResult[] = [];

    // occurred_at 昇順で処理する。
    // 状態遷移の意味づけ（どのイベントで復帰したか）を時系列に沿わせるため。
    const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    for (const e of sorted) {
      results.push(await ingestEvent(e, client));
    }

    // 状態が変わった場合のみ監査ログを残す（ALIVE→ALIVE の毎回記録はノイズであり、
    // 監査ログが実質無限に膨らむ）。
    // previousStatus は最初に復帰を起こしたイベントの投入直前の状態。
    const revived = results.find((r) => r.revivedToAlive);
    if (revived?.previousStatus) {
      await audit(
        sorted[0]!.clientId,
        'status_change',
        {
          from: revived.previousStatus,
          to: 'ALIVE',
          reason: 'alive_event_received',
          source_type: sorted[0]!.sourceType,
        },
        client,
      );
    }

    return results;
  });
}
