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
