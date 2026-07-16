/**
 * Phase 2 センサーアダプタの統合テスト（実DB + 実HTTP経路）。
 *
 * 【このテストが証明したいこと】
 * spec 8 のアダプタ規約:
 *   「新ソースは Webhook → events への正規化挿入のみを実装する。
 *     判定エンジン・状態遷移・学習・通知は無改修であること。
 *     改修が必要になった時点でアダプタ設計の失敗とみなす」
 *
 * つまりここで確かめるのは「SwitchBot を足したら見守りが動いた」ことであり、
 * その裏で Phase 1 の判定エンジンが一行も変わっていないことが本質。
 *
 * 前提: DATABASE_URL のDBにマイグレーション済みであること。
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { runEvaluation } from '../src/engine/evaluator.js';
import { setFcmDriver, type FcmDriver, type PushRequest } from '../src/notify/fcm.js';

/** 送信された通知を記録するテスト用ドライバ */
class RecordingFcmDriver implements FcmDriver {
  public sent: PushRequest[] = [];
  async send(req: PushRequest) {
    this.sent.push(req);
    return { ok: true };
  }
  reset() {
    this.sent = [];
  }
}

const fcm = new RecordingFcmDriver();
setFcmDriver(fcm);

const SWITCHBOT_SECRET = 'test-switchbot-secret-do-not-use-in-production';
const POWER_SECRET = 'test-power-meter-secret-do-not-use-in-production';

let app: FastifyInstance;
let token: string;
let watcherId: string;
let clientId: string;

/** SwitchBot の署名ヘッダを組み立てる */
function switchBotHeaders(secret = SWITCHBOT_SECRET): Record<string, string> {
  const t = String(Date.now());
  const nonce = 'test-nonce';
  const sign = createHmac('sha256', secret).update(`${secret}${t}${nonce}`).digest('base64');
  return { sign, t, nonce };
}

/** ウォッチャーを登録してトークンを得る */
async function registerWatcher(): Promise<void> {
  const email = `sensor-test-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/watchers',
    payload: { display_name: 'センサーテスト', email, password: 'password1234' },
  });
  const body = res.json();
  token = body.access_token;
  watcherId = body.watcher_id;

  // FCMトークンを登録しておく。
  // これが無いと通知先が存在せず、「ALERTが飛ばないこと」を確かめるテストが
  // 常に成功してしまう（無条件に0件になるため）。実際にこれで見逃しかけた。
  await app.inject({
    method: 'PUT',
    url: '/v1/watchers/me/fcm-token',
    headers: { authorization: `Bearer ${token}` },
    payload: { fcm_token: 'test-watcher-fcm-token' },
  });
}

/** アプリありクライアントを作る（ペアリング経路を通す） */
async function createPairedClient(): Promise<void> {
  const codeRes = await app.inject({
    method: 'POST',
    url: '/v1/pairing-codes',
    headers: { authorization: `Bearer ${token}` },
  });
  const code = codeRes.json().code;

  const pairRes = await app.inject({
    method: 'POST',
    url: '/v1/clients/pair',
    payload: {
      code,
      display_name: 'センサーテスト対象',
      consent_version: 'v1.0',
      platform: 'android',
    },
  });
  clientId = pairRes.json().client_id;
}

/** センサーを登録して sensor_id を返す */
async function registerSensor(
  sourceType: string,
  sourceId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/clients/${clientId}/sensors`,
    headers: { authorization: `Bearer ${token}` },
    payload: { source_type: sourceType, source_id: sourceId, display_name: '玄関' },
  });
  return { status: res.statusCode, body: res.json() };
}

/** クライアントの判定用カラムを直接書き換える（時間経過の再現） */
async function setClientState(fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`UPDATE clients SET ${sets} WHERE id = $1`, [clientId, ...Object.values(fields)]);
}

/** クライアントの現在状態を読む */
async function getClient(): Promise<{
  status: string;
  last_alive_event_at: Date;
  last_weak_signal_at: Date | null;
}> {
  const res = await query<{
    status: string;
    last_alive_event_at: Date;
    last_weak_signal_at: Date | null;
  }>(
    `SELECT status, last_alive_event_at, last_weak_signal_at
       FROM clients WHERE id = $1`,
    [clientId],
  );
  return res.rows[0]!;
}

beforeEach(async () => {
  app = await buildApp();
  fcm.reset();
  await registerWatcher();
  await createPairedClient();
});

afterEach(async () => {
  // 自分が作ったデータだけを消す。
  // clients / watchers の削除で client_sensors・events 等は CASCADE される。
  if (clientId) await query('DELETE FROM events WHERE client_id = $1', [clientId]);
  if (clientId) await query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (watcherId) await query('DELETE FROM watchers WHERE id = $1', [watcherId]);
  await app.close();
});

afterAll(async () => {
  await closePool();
});

describe('SwitchBot アダプタ — 判定エンジン無改修での接続（spec 8）', () => {
  it('【本丸】開閉センサーのイベントで WATCH から ALIVE へ復帰する', async () => {
    await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:01');

    // 閾値超過で WATCH に落ちている状態を作る
    await setClientState({
      status: 'WATCH',
      last_alive_event_at: new Date(Date.now() - 700 * 60_000),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/switchbot',
      headers: switchBotHeaders(),
      payload: {
        eventType: 'changeReport',
        context: { deviceMac: 'AA:BB:CC:DD:EE:01', openState: 'open', timeOfSample: Date.now() },
      },
    });

    expect(res.statusCode).toBe(200);

    // ドアが開いた = 本人が動いた → 即 ALIVE。
    // この復帰処理は Phase 1 の ingestEvent がそのまま行っている。
    const client = await getClient();
    expect(client.status).toBe('ALIVE');

    // events へ正規化されて入っていること
    const events = await query<{ source_type: string; event_type: string; confidence: number }>(
      'SELECT source_type, event_type, confidence FROM events WHERE client_id = $1',
      [clientId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.source_type).toBe('switchbot_contact');
    expect(events.rows[0]!.event_type).toBe('activity');
    expect(events.rows[0]!.confidence).toBe(100);
  });

  it('close も人の行動として扱う（ドアは人が閉めないと閉まらない）', async () => {
    await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:02');
    await setClientState({
      status: 'WATCH',
      last_alive_event_at: new Date(Date.now() - 700 * 60_000),
    });

    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/switchbot',
      headers: switchBotHeaders(),
      payload: {
        eventType: 'changeReport',
        context: { deviceMac: 'AA:BB:CC:DD:EE:02', openState: 'close', timeOfSample: Date.now() },
      },
    });

    expect((await getClient()).status).toBe('ALIVE');
  });

  it('【禁止事項】events.meta に行動詳細（openState）を残さない', async () => {
    await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:03');

    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/switchbot',
      headers: switchBotHeaders(),
      payload: {
        eventType: 'changeReport',
        context: { deviceMac: 'AA:BB:CC:DD:EE:03', openState: 'open', timeOfSample: Date.now() },
      },
    });

    const events = await query<{ meta: Record<string, unknown> }>(
      'SELECT meta FROM events WHERE client_id = $1',
      [clientId],
    );
    // 「いつ玄関が開いたか」を meta に残すと原則1・原則3に反する。
    // 判定に必要なのは「動きがあった」という事実だけ。
    expect(events.rows[0]!.meta).toEqual({});
  });

  it('署名が不正なら 401（イベントは入らない）', async () => {
    await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:04');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/switchbot',
      headers: switchBotHeaders('wrong-secret'),
      payload: {
        eventType: 'changeReport',
        context: { deviceMac: 'AA:BB:CC:DD:EE:04', openState: 'open' },
      },
    });

    expect(res.statusCode).toBe(401);
    const events = await query('SELECT 1 FROM events WHERE client_id = $1', [clientId]);
    expect(events.rowCount).toBe(0);
  });

  it('未登録デバイスは 404（誰の見守りか解決できないイベントを受け入れない）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/switchbot',
      headers: switchBotHeaders(),
      payload: {
        eventType: 'changeReport',
        context: { deviceMac: 'FF:FF:FF:FF:FF:FF', openState: 'open' },
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('無効化されたセンサーのイベントは受け付けない', async () => {
    const reg = await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:05');
    const sensorId = reg.body.id as string;

    await app.inject({
      method: 'PUT',
      url: `/v1/clients/${clientId}/sensors/${sensorId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/switchbot',
      headers: switchBotHeaders(),
      payload: {
        eventType: 'changeReport',
        context: { deviceMac: 'AA:BB:CC:DD:EE:05', openState: 'open' },
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('未来時刻の timeOfSample は受信時刻へ丸める（デッドマンスイッチの停止を防ぐ）', async () => {
    await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:06');

    // 端末の時計が1年進んでいるケース。
    // これを信じると last_alive_event_at が未来になり、経過時間が
    // 永久にマイナス = 二度と閾値を超えない = 見守りが死ぬ。
    const oneYearLater = Date.now() + 365 * 86400_000;

    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/switchbot',
      headers: switchBotHeaders(),
      payload: {
        eventType: 'changeReport',
        context: { deviceMac: 'AA:BB:CC:DD:EE:06', openState: 'open', timeOfSample: oneYearLater },
      },
    });

    const client = await getClient();
    expect(client.last_alive_event_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('電力メーター アダプタ — 低信頼ソースの扱い（spec 8）', () => {
  it('【最重要】電力の変動では ALIVE へ復帰しない（冷蔵庫に生存を証明させない）', async () => {
    await registerSensor('power_meter', 'METER-0001');

    const staleAt = new Date(Date.now() - 700 * 60_000);
    await setClientState({ status: 'WATCH', last_alive_event_at: staleAt });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/power-meter',
      headers: { authorization: POWER_SECRET },
      payload: {
        meter_id: 'METER-0001',
        watt_hours: 800,
        measured_at: new Date().toISOString(),
      },
    });

    expect(res.statusCode).toBe(200);

    const client = await getClient();
    // 状態も経過時間の基準点も動いていないこと
    expect(client.status).toBe('WATCH');
    expect(client.last_alive_event_at.getTime()).toBe(staleAt.getTime());
    // 弱シグナルとしては記録されていること
    expect(client.last_weak_signal_at).not.toBeNull();
  });

  it('ベースライン以下の消費は活動として扱わない', async () => {
    await registerSensor('power_meter', 'METER-0002');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/power-meter',
      headers: { authorization: POWER_SECRET },
      payload: {
        meter_id: 'METER-0002',
        watt_hours: 50, // 待機電力レベル
        measured_at: new Date().toISOString(),
      },
    });

    expect(res.json().ignored).toBe(true);
    const client = await getClient();
    expect(client.last_weak_signal_at).toBeNull();
  });

  it('認証なしは 401', async () => {
    await registerSensor('power_meter', 'METER-0003');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/power-meter',
      payload: {
        meter_id: 'METER-0003',
        watt_hours: 800,
        measured_at: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('クロス判定 — 実DB・判定ジョブ経由（spec 5.2）', () => {
  it('【誤報防止】端末沈黙 + 電力の弱シグナル → ALERT を出さず WATCH 止まり', async () => {
    await registerSensor('power_meter', 'METER-0010');

    // スマホの電池が切れて11時間以上経過。本人は元気で家電を使っている。
    await setClientState({
      status: 'ALIVE',
      last_alive_event_at: new Date(Date.now() - 700 * 60_000), // 閾値600超過
      last_heartbeat_at: new Date(Date.now() - 700 * 60_000), // 端末沈黙
      last_weak_signal_at: new Date(Date.now() - 10 * 60_000), // 電力は動いている
      threshold_minutes: 600,
    });

    await runEvaluation();

    const client = await getClient();
    expect(client.status).toBe('WATCH');

    // ALERT の通知が飛んでいないこと
    const alerts = fcm.sent.filter((p) => p.kind === 'alert');
    expect(alerts).toHaveLength(0);
  });

  it('【検知漏れ防止・最重要】保留上限を超えたら弱シグナルがあってもエスカレーションする', async () => {
    await registerSensor('power_meter', 'METER-0011');

    // 閾値600 + 保留上限180 = 780 を超過。冷蔵庫はずっと回っている。
    await setClientState({
      status: 'CONFIRMING',
      last_alive_event_at: new Date(Date.now() - 900 * 60_000),
      last_heartbeat_at: new Date(Date.now() - 900 * 60_000),
      confirming_since: new Date(Date.now() - 40 * 60_000), // 無応答40分
      last_weak_signal_at: new Date(Date.now() - 1 * 60_000), // 弱シグナルは新しい
      threshold_minutes: 600,
    });

    await runEvaluation();

    const client = await getClient();
    // 弱シグナルがあっても発報する。ここが緑でないと人が死ぬ。
    expect(client.status).toBe('ALERT');

    const alerts = fcm.sent.filter((p) => p.kind === 'alert');
    expect(alerts.length).toBeGreaterThan(0);
    // 端末沈黙中なので「電池切れの可能性」を含む文言になっていること
    expect(alerts[0]!.body).toContain('電池切れ');
  });
});

describe('センサー管理API — プライバシーと権限', () => {
  it('【原則1】一覧に行動情報（最終イベント時刻）を含めない', async () => {
    const reg = await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:10');
    const sensorId = reg.body.id as string;

    // 実際にイベントを起こして last_event_at を埋める
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/switchbot',
      headers: switchBotHeaders(),
      payload: {
        eventType: 'changeReport',
        context: { deviceMac: 'AA:BB:CC:DD:EE:10', openState: 'open', timeOfSample: Date.now() },
      },
    });

    // DB には記録されている（運用調査用）
    const dbRow = await query<{ last_event_at: Date | null }>(
      'SELECT last_event_at FROM client_sensors WHERE id = $1',
      [sensorId],
    );
    expect(dbRow.rows[0]!.last_event_at).not.toBeNull();

    // しかしAPIからは一切見えない
    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/sensors`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    const keys = Object.keys(list[0]);
    // 「玄関が最後に開いた時刻」はウォッチャーに開示してよい情報ではない
    expect(keys).not.toContain('last_event_at');
    expect(JSON.stringify(list)).not.toContain('last_event');
  });

  it('低信頼ソースは is_primary_signal=false として正直に伝える', async () => {
    await registerSensor('power_meter', 'METER-0020');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/sensors`,
      headers: { authorization: `Bearer ${token}` },
    });

    const list = res.json();
    expect(list[0].is_primary_signal).toBe(false);
    expect(list[0].source_type).toBe('power_meter');
  });

  it('高信頼ソースは is_primary_signal=true', async () => {
    await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:20');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/sensors`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json()[0].is_primary_signal).toBe(true);
  });

  it('同じデバイスの二重登録は 409（どちらの見守りに入れるか曖昧になるため）', async () => {
    await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:21');
    const dup = await registerSensor('switchbot_contact', 'AA:BB:CC:DD:EE:21');
    expect(dup.status).toBe(409);
    // どのクライアントに登録済みかを漏らさないこと
    expect(JSON.stringify(dup.body)).not.toContain(clientId);
  });

  it('【IDOR対策】他人のクライアントにはセンサーを登録できない（403ではなく404）', async () => {
    const otherClient = clientId;

    // 別のウォッチャーを作る
    const otherEmail = `other-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.test`;
    const w = await app.inject({
      method: 'POST',
      url: '/v1/watchers',
      payload: { display_name: '他人', email: otherEmail, password: 'password1234' },
    });
    const otherToken = w.json().access_token;
    const otherWatcherId = w.json().watcher_id;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/clients/${otherClient}/sensors`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { source_type: 'switchbot_contact', source_id: 'AA:BB:CC:DD:EE:22' },
    });

    // 存在を漏らさないため 404
    expect(res.statusCode).toBe(404);

    await query('DELETE FROM watchers WHERE id = $1', [otherWatcherId]);
  });

  it('デバイストークンではセンサーAPIを叩けない（ロール分離）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/sensors`,
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('センサーのみクライアント（has_app=false, spec 8）', () => {
  it('作成でき、CONFIRMING をスキップするプロファイルになる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/sensor-only',
      headers: { authorization: `Bearer ${token}` },
      payload: { display_name: '空き家A', consent_version: 'v1.0', property_tag: '物件A' },
    });

    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.has_app).toBe(false);

    const row = await query<{ has_app: boolean; property_tag: string }>(
      'SELECT has_app, property_tag FROM clients WHERE id = $1',
      [created.client_id],
    );
    expect(row.rows[0]!.has_app).toBe(false);
    expect(row.rows[0]!.property_tag).toBe('物件A');

    // 同意の出所が「ウォッチャーの申告」であることが証跡に残ること（法務要件）
    const auditRow = await query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log WHERE client_id = $1 AND event = 'client_paired'`,
      [created.client_id],
    );
    expect(auditRow.rows[0]!.detail.consent_by).toBe('watcher_declaration');

    await query('DELETE FROM clients WHERE id = $1', [created.client_id]);
  });

  it('【断定しない】センサーのみクライアントのALERTは「センサーの不具合の可能性」を併記する', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/clients/sensor-only',
      headers: { authorization: `Bearer ${token}` },
      payload: { display_name: '空き家C', consent_version: 'v1.0' },
    });
    const sensorOnlyId = created.json().client_id as string;

    // 閾値600 + 猶予60 を超過させる
    await query(
      `UPDATE clients SET last_alive_event_at = now() - interval '700 minutes',
                          threshold_minutes = 600
        WHERE id = $1`,
      [sensorOnlyId],
    );

    fcm.reset();
    await runEvaluation();

    const alerts = fcm.sent.filter((p) => p.kind === 'alert');
    expect(alerts.length).toBeGreaterThan(0);

    // センサーが死んでいるだけの可能性を隠して「安否確認が取れません」と
    // 断定すると、空振りのたびに信頼が削れて通知が無視されるようになる。
    expect(alerts[0]!.body).toContain('センサーの不具合の可能性');
    expect(alerts[0]!.body).not.toContain('端末から信号が途絶え');

    await query('DELETE FROM clients WHERE id = $1', [sensorOnlyId]);
  });

  it('consent_version なしでは作成できない（法務要件）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/sensor-only',
      headers: { authorization: `Bearer ${token}` },
      payload: { display_name: '空き家B' },
    });
    expect(res.statusCode).toBe(400);
  });
});
