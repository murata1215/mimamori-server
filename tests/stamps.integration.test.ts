/**
 * スタンプ機能の統合テスト。
 *
 * 【このテストが守るもの】
 * - クライアント→ウォッチャー / ウォッチャー→クライアントの双方向スタンプ送受信
 * - direction ('from_client' / 'from_watcher') の正しさ
 * - sender_name のスナップショット保存
 * - watch_link のない watcher からの操作は 404
 * - cursor ページネーション（before_id）
 * - FCM push の kind='stamp' と data 内容
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { setFcmDriver, type FcmDriver, type PushRequest } from '../src/notify/fcm.js';

class RecordingFcmDriver implements FcmDriver {
  public sent: PushRequest[] = [];
  async send(req: PushRequest) {
    this.sent.push(req);
    return { ok: true };
  }
  reset() { this.sent = []; }
}

const fcm = new RecordingFcmDriver();
setFcmDriver(fcm);

let app: FastifyInstance;
let watcherToken: string;
let watcherId: string;
let deviceToken: string;
let clientId: string;

const WATCHER_NAME = 'テスト見守り人';
const CLIENT_NAME = 'テスト高齢者';

async function setup(): Promise<void> {
  const email = `stamp-test-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.test`;
  const wRes = await app.inject({
    method: 'POST',
    url: '/v1/watchers',
    payload: { display_name: WATCHER_NAME, email, password: 'password1234' },
  });
  const wBody = wRes.json();
  watcherToken = wBody.access_token;
  watcherId = wBody.watcher_id;

  // FCM token を設定（push テスト用）
  await app.inject({
    method: 'PUT',
    url: '/v1/watchers/me/fcm-token',
    headers: { authorization: `Bearer ${watcherToken}` },
    payload: { fcm_token: 'test-watcher-fcm' },
  });

  // ペアリング
  const codeRes = await app.inject({
    method: 'POST',
    url: '/v1/pairing-codes',
    headers: { authorization: `Bearer ${watcherToken}` },
  });
  const pairRes = await app.inject({
    method: 'POST',
    url: '/v1/clients/pair',
    payload: {
      code: codeRes.json().code,
      display_name: CLIENT_NAME,
      consent_version: 'v1.0',
      platform: 'android',
      fcm_token: 'test-device-fcm',
    },
  });
  const pBody = pairRes.json();
  clientId = pBody.client_id;
  deviceToken = pBody.device_token;
}

beforeEach(async () => {
  app = await buildApp();
  fcm.reset();
  await setup();
});

afterEach(async () => {
  if (clientId) {
    await query('DELETE FROM stamps WHERE client_id = $1', [clientId]);
    await query('DELETE FROM events WHERE client_id = $1', [clientId]);
    await query('DELETE FROM audit_log WHERE client_id = $1', [clientId]);
    await query('DELETE FROM clients WHERE id = $1', [clientId]);
  }
  if (watcherId) await query('DELETE FROM watchers WHERE id = $1', [watcherId]);
  await app.close();
});

afterAll(async () => {
  await closePool();
});

describe('POST /v1/stamps — クライアントがスタンプ送信', () => {
  it('201 で stamp_id を返す', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stamps',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { stamp: 'fine' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().stamp_id).toBeDefined();
  });

  it('stamp がないと 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/stamps',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('ウォッチャー宛の FCM push に kind=stamp と client_name が含まれる', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/stamps',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { stamp: 'not_well' },
    });

    // FCM push は非同期のため少し待つ
    await new Promise((r) => setTimeout(r, 100));

    const stampPush = fcm.sent.find((s) => s.kind === 'stamp');
    expect(stampPush).toBeDefined();
    expect(stampPush!.data?.stamp).toBe('not_well');
    expect(stampPush!.data?.client_name).toBe(CLIENT_NAME);
    expect(stampPush!.data?.direction).toBe('from_client');
  });
});

describe('POST /v1/clients/:client_id/stamps — ウォッチャーがスタンプ送信', () => {
  it('201 で stamp_id を返す', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/clients/${clientId}/stamps`,
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { stamp: 'fine' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().stamp_id).toBeDefined();
  });

  it('watch_link のないクライアントには 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/00000000-0000-0000-0000-000000000000/stamps',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { stamp: 'fine' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('不正な UUID は 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/not-a-uuid/stamps',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { stamp: 'fine' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/stamps/me — クライアントの履歴取得', () => {
  it('双方向の履歴が新しい順で返る', async () => {
    // クライアントから送信
    await app.inject({
      method: 'POST',
      url: '/v1/stamps',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { stamp: 'fine' },
    });

    // ウォッチャーから送信
    await app.inject({
      method: 'POST',
      url: `/v1/clients/${clientId}/stamps`,
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { stamp: 'bad' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/stamps/me',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);

    // 新しい順 → ウォッチャーからのが先
    expect(body[0].stamp).toBe('bad');
    expect(body[0].direction).toBe('from_watcher');
    expect(body[0].sender_name).toBe(WATCHER_NAME);
    expect(typeof body[0].id).toBe('string');
    expect(typeof body[0].created_at).toBe('string');

    expect(body[1].stamp).toBe('fine');
    expect(body[1].direction).toBe('from_client');
    expect(body[1].sender_name).toBe(CLIENT_NAME);
  });

  it('before_id で cursor ページネーションができる', async () => {
    // 3件送信
    for (const s of ['fine', 'not_well', 'bad']) {
      await app.inject({
        method: 'POST',
        url: '/v1/stamps',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: { stamp: s },
      });
    }

    // 全件取得
    const allRes = await app.inject({
      method: 'GET',
      url: '/v1/stamps/me',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const all = allRes.json();
    expect(all).toHaveLength(3);

    // before_id で2件目以降を取得
    const pageRes = await app.inject({
      method: 'GET',
      url: `/v1/stamps/me?before_id=${all[0].id}`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const page = pageRes.json();
    expect(page).toHaveLength(2);
    expect(page[0].id).toBe(all[1].id);
  });

  it('limit パラメータが効く', async () => {
    for (const s of ['fine', 'not_well', 'bad']) {
      await app.inject({
        method: 'POST',
        url: '/v1/stamps',
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: { stamp: s },
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/v1/stamps/me?limit=2',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.json()).toHaveLength(2);
  });
});

describe('GET /v1/clients/:client_id/stamps — ウォッチャーの閲覧', () => {
  it('双方向の履歴が返る', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/stamps',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { stamp: 'fine' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/stamps`,
      headers: { authorization: `Bearer ${watcherToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].direction).toBe('from_client');
  });

  it('watch_link のないクライアントには 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/clients/00000000-0000-0000-0000-000000000000/stamps',
      headers: { authorization: `Bearer ${watcherToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
