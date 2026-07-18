/**
 * Flutter クライアント連携の API 契約テスト（実DB + 実HTTP経路）。
 *
 * 【このテストが守るもの】(flutter連携 2026-07-17)
 * - 依頼1: ウォッチャー宛 FCM push の data payload に client_name が載ること。
 *   ウォッチャー端末がオフライン・起動直後でも、API照会なしに「誰の」通知かを
 *   表示できるようにするための契約。ここが欠けると通知が汎用文言に退化する。
 * - 依頼2: POST /v1/sos/:id/resolve が空ボディ / {} で 400 にならず 200 になること。
 *   Flutter 側は保険として常に {} を送るため、その挙動を回帰テストで固定する。
 *
 * 前提: DATABASE_URL のDBにマイグレーション済みであること。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
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

let app: FastifyInstance;
let watcherToken: string;
let deviceToken: string;
let watcherId: string;
let clientId: string;

const CLIENT_NAME = '契約テスト対象';

/** ウォッチャーを登録し、FCMトークンまで設定する */
async function registerWatcher(): Promise<void> {
  const email = `contract-test-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/watchers',
    payload: { display_name: '契約テスト見守り', email, password: 'password1234' },
  });
  const body = res.json();
  watcherToken = body.access_token;
  watcherId = body.watcher_id;

  // 通知先が無いと push が飛ばず、client_name の検証ができない。
  await app.inject({
    method: 'PUT',
    url: '/v1/watchers/me/fcm-token',
    headers: { authorization: `Bearer ${watcherToken}` },
    payload: { fcm_token: 'test-watcher-fcm-token' },
  });
}

/** アプリありクライアントをペアリング経路で作り、device_token を得る */
async function createPairedClient(): Promise<void> {
  const codeRes = await app.inject({
    method: 'POST',
    url: '/v1/pairing-codes',
    headers: { authorization: `Bearer ${watcherToken}` },
  });
  const code = codeRes.json().code;

  const pairRes = await app.inject({
    method: 'POST',
    url: '/v1/clients/pair',
    payload: {
      code,
      display_name: CLIENT_NAME,
      consent_version: 'v1.0',
      platform: 'android',
    },
  });
  const body = pairRes.json();
  clientId = body.client_id;
  deviceToken = body.device_token;
}

beforeEach(async () => {
  app = await buildApp();
  fcm.reset();
  await registerWatcher();
  await createPairedClient();
});

afterEach(async () => {
  if (clientId) await query('DELETE FROM events WHERE client_id = $1', [clientId]);
  if (clientId) await query('DELETE FROM sos_incidents WHERE client_id = $1', [clientId]);
  if (clientId) await query('DELETE FROM audit_log WHERE client_id = $1', [clientId]);
  if (clientId) await query('DELETE FROM clients WHERE id = $1', [clientId]);
  if (watcherId) await query('DELETE FROM watchers WHERE id = $1', [watcherId]);
  await app.close();
});

afterAll(async () => {
  await closePool();
});

describe('FCM data payload — client_name（依頼1）', () => {
  it('SOS 発動時の push に client_name と incident_id が載る', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sos',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { lat: 35.6812, lng: 139.7671, battery_level: 15 },
    });
    expect(res.statusCode).toBe(201);
    const incidentId = res.json().incident_id;

    const sosPush = fcm.sent.find((s) => s.kind === 'sos');
    expect(sosPush).toBeDefined();
    expect(sosPush!.token).toBe('test-watcher-fcm-token');
    expect(sosPush!.data?.client_name).toBe(CLIENT_NAME);
    expect(sosPush!.data?.incident_id).toBe(incidentId);
    // client_id は pushToWatcher が常に付与する。併せて確認する。
    expect(sosPush!.data?.client_id).toBe(clientId);
  });

  it('権限失効の通知にも client_name が載る（permission kind）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/permission-health',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { issues: ['usage_stats', 'battery_optimization'] },
    });
    expect(res.statusCode).toBe(200);

    const permPush = fcm.sent.find((s) => s.kind === 'permission');
    expect(permPush).toBeDefined();
    expect(permPush!.data?.client_name).toBe(CLIENT_NAME);
  });
});

describe('GET /statusz — 公開ステータス（集計のみ・個人情報非公開）', () => {
  it('200 で集計キーを返し、稼働状態と利用者数が数値で載る', async () => {
    const res = await app.inject({ method: 'GET', url: '/statusz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.service).toBe('mimamori-server');
    // healthz と同じ判定。テスト環境では ok または starting のいずれか。
    expect(['ok', 'starting', 'unhealthy']).toContain(body.status);

    // 集計キーがすべて数値であること。
    for (const key of ['watchers', 'clients', 'unique_users', 'watch_links', 'devices']) {
      expect(typeof body[key]).toBe('number');
    }
    // beforeEach で watcher と client を1件ずつ作っているため 1 以上。
    expect(body.watchers).toBeGreaterThanOrEqual(1);
    expect(body.clients).toBeGreaterThanOrEqual(1);
    expect(body.unique_users).toBe(body.watchers + body.clients);
    expect(typeof body.generated_at).toBe('string');
  });

  it('個人を特定しうる情報を一切含めない（絶対ルール2/3）', async () => {
    const res = await app.inject({ method: 'GET', url: '/statusz' });
    const body = res.json();

    // 名前・ID・個別/内訳ステータス・時刻系のキーが露出していないこと。
    const forbidden = [
      'display_name', 'name', 'client_id', 'watcher_id', 'id', 'email',
      'last_alive_event_at', 'last_event_at', 'status_changed_at',
      'ALERT', 'SOS', 'CONFIRMING', 'WATCH', 'ALIVE',
      'alert', 'sos', 'incidents', 'by_status', 'statuses',
    ];
    for (const key of forbidden) {
      expect(body).not.toHaveProperty(key);
    }
    // status は集約ラベル（ok/starting/unhealthy）のみで、内訳オブジェクトではない。
    expect(typeof body.status).toBe('string');
  });
});

describe('GET / — 公開ステータスページ（HTML）', () => {
  it('text/html を返す（JSON エラーではない）', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('mimamori-server');
  });
});

describe('GET /v1/clients/:client_id/sos/active — アクティブSOS取得', () => {
  async function fireSos(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sos',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { lat: 35.68, lng: 139.77, battery_level: 42, location_captured_at: '2026-07-18T01:00:00Z' },
    });
    return res.json().incident_id;
  }

  it('アクティブ SOS がある場合 200 で incident 詳細が返る', async () => {
    const incidentId = await fireSos();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/sos/active`,
      headers: { authorization: `Bearer ${watcherToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(incidentId);
    expect(body.client_id).toBe(clientId);
    expect(body.client_name).toBe(CLIENT_NAME);
    expect(body.latitude).toBe(35.68);
    expect(body.longitude).toBe(139.77);
    expect(body.battery_level).toBe(42);
    expect(body.fired_at).toBeTruthy();
    expect(body.resolved_at).toBeNull();
    expect(body.location_captured_at).toBe('2026-07-18T01:00:00.000Z');
  });

  it('アクティブ SOS がない場合 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/sos/active`,
      headers: { authorization: `Bearer ${watcherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('resolve 済みの SOS しかない場合 404', async () => {
    const incidentId = await fireSos();

    // resolve
    await app.inject({
      method: 'POST',
      url: `/v1/sos/${incidentId}/resolve`,
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: {},
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/sos/active`,
      headers: { authorization: `Bearer ${watcherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('権限のないクライアントへは 404（存在を漏らさない）', async () => {
    await fireSos();

    // 別の watcher を作成
    const email2 = `unrelated-${Date.now()}@example.test`;
    const w2 = await app.inject({
      method: 'POST',
      url: '/v1/watchers',
      payload: { display_name: '無関係', email: email2, password: 'password1234' },
    });
    const otherToken = w2.json().access_token;
    const otherWatcherId = w2.json().watcher_id;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/sos/active`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(404);

    // cleanup
    await query('DELETE FROM watchers WHERE id = $1', [otherWatcherId]);
  });
});

describe('POST /v1/sos/:id/resolve — 空ボディ受理（依頼2）', () => {
  /** SOS を発動して incident_id を返す */
  async function fireSos(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sos',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { battery_level: 20 },
    });
    return res.json().incident_id;
  }

  it('{}（空 JSON オブジェクト）で 200 { ok: true } になる', async () => {
    const incidentId = await fireSos();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sos/${incidentId}/resolve`,
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('ボディ完全省略でも 200 { ok: true } になる', async () => {
    const incidentId = await fireSos();
    // payload を渡さない = Content-Type なし・ボディなし。
    // ハンドラは req.body ?? {} で受けるため 400 にならないことを固定する。
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sos/${incidentId}/resolve`,
      headers: { authorization: `Bearer ${watcherToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('outcome を明示した場合も従来どおり 200 になる', async () => {
    const incidentId = await fireSos();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/sos/${incidentId}/resolve`,
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { outcome: 'was_safe' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
