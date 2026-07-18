/**
 * クライアント（見守られ側）機種変更対応の統合テスト。
 *
 * 【このテストが守るもの】
 * - POST /v1/clients/me/email: デバイス認証でメール+パスワード付与
 * - POST /v1/clients/login: メール認証で新端末にデバイストークン発行
 * - ログイン時の旧端末無効化（deactivated_at 設定 → requireDevice で 401）
 * - 新端末のデバイストークンが正常に動作すること
 * - consent_version の更新・監査記録
 * - 既登録・メール重複の 409 ハンドリング
 * - watchers と clients で同一メールが登録できること
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { setFcmDriver, type FcmDriver, type PushRequest } from '../src/notify/fcm.js';

class NoOpFcmDriver implements FcmDriver {
  public sent: PushRequest[] = [];
  async send(req: PushRequest) { this.sent.push(req); return { ok: true }; }
  reset() { this.sent = []; }
}

const fcm = new NoOpFcmDriver();
setFcmDriver(fcm);

let app: FastifyInstance;
const createdClientIds: string[] = [];
const createdWatcherIds: string[] = [];

beforeEach(async () => {
  app = await buildApp();
  fcm.reset();
});

afterEach(async () => {
  for (const id of createdClientIds) {
    await query('DELETE FROM devices WHERE client_id = $1', [id]);
    await query('DELETE FROM watch_links WHERE client_id = $1', [id]);
    await query('DELETE FROM events WHERE client_id = $1', [id]);
    await query('DELETE FROM audit_log WHERE client_id = $1', [id]);
    await query('DELETE FROM clients WHERE id = $1', [id]);
  }
  for (const id of createdWatcherIds) {
    await query('DELETE FROM watch_links WHERE watcher_id = $1', [id]);
    await query('DELETE FROM watchers WHERE id = $1', [id]);
  }
  createdClientIds.length = 0;
  createdWatcherIds.length = 0;
  await app.close();
});

afterAll(async () => {
  await closePool();
});

/** ウォッチャーを作成してトークンを返す */
async function createWatcher(): Promise<{ watcherId: string; token: string }> {
  const email = `test-ca-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/watchers',
    payload: { display_name: 'テストウォッチャー', email, password: 'password1234' },
  });
  const body = JSON.parse(res.body);
  createdWatcherIds.push(body.watcher_id);
  return { watcherId: body.watcher_id, token: body.access_token };
}

/** ペアリングでクライアント+デバイスを作成しトークンを返す */
async function createClientViaProvisioning(watcherToken: string): Promise<{
  clientId: string;
  deviceToken: string;
}> {
  // ペアリングコード発行
  const codeRes = await app.inject({
    method: 'POST',
    url: '/v1/pairing-codes',
    headers: { authorization: `Bearer ${watcherToken}` },
  });
  const { code } = JSON.parse(codeRes.body);

  // クライアント作成
  const pairRes = await app.inject({
    method: 'POST',
    url: '/v1/clients/pair',
    payload: {
      code,
      display_name: 'テスト高齢者',
      consent_version: '1.0',
      platform: 'android',
    },
  });
  const pairBody = JSON.parse(pairRes.body);
  createdClientIds.push(pairBody.client_id);
  return { clientId: pairBody.client_id, deviceToken: pairBody.device_token };
}

const testEmail = () => `client-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.com`;

describe('POST /v1/clients/me/email', () => {
  it('メール+パスワードを付与できる（200）', async () => {
    const { token: wToken } = await createWatcher();
    const { deviceToken } = await createClientViaProvisioning(wToken);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email: testEmail(), password: 'securepass123' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('既にメール登録済みなら 409 already_registered', async () => {
    const { token: wToken } = await createWatcher();
    const { deviceToken } = await createClientViaProvisioning(wToken);
    const email = testEmail();

    // 1回目: 成功
    await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email, password: 'securepass123' },
    });

    // 2回目: 409
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email: testEmail(), password: 'securepass123' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('already_registered');
  });

  it('他クライアントが使用中のメールなら 409 email_taken', async () => {
    const { token: wToken } = await createWatcher();
    const { deviceToken: dt1 } = await createClientViaProvisioning(wToken);
    const { deviceToken: dt2 } = await createClientViaProvisioning(wToken);
    const email = testEmail();

    // クライアント1にメール登録
    await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${dt1}` },
      payload: { email, password: 'securepass123' },
    });

    // クライアント2に同じメール → 409
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${dt2}` },
      payload: { email, password: 'securepass123' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('email_taken');
  });

  it('バリデーションエラー（パスワード短い）→ 400', async () => {
    const { token: wToken } = await createWatcher();
    const { deviceToken } = await createClientViaProvisioning(wToken);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email: testEmail(), password: 'short' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/clients/login', () => {
  it('メールログインで新デバイストークンを取得できる（200）', async () => {
    const { token: wToken } = await createWatcher();
    const { clientId, deviceToken } = await createClientViaProvisioning(wToken);
    const email = testEmail();

    // メール登録
    await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email, password: 'securepass123' },
    });

    // ログイン
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/login',
      payload: {
        email,
        password: 'securepass123',
        platform: 'ios',
        consent_version: '2.0',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.client_id).toBe(clientId);
    expect(body.device_id).toBeTruthy();
    expect(body.device_token).toBeTruthy();
  });

  it('ログイン後、旧デバイストークンは 401 になる', async () => {
    const { token: wToken } = await createWatcher();
    const { deviceToken: oldToken } = await createClientViaProvisioning(wToken);
    const email = testEmail();

    // メール登録
    await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${oldToken}` },
      payload: { email, password: 'securepass123' },
    });

    // ログイン（新端末）
    await app.inject({
      method: 'POST',
      url: '/v1/clients/login',
      payload: {
        email,
        password: 'securepass123',
        platform: 'ios',
        consent_version: '2.0',
      },
    });

    // 旧トークンでハートビート → 401
    const res = await app.inject({
      method: 'POST',
      url: '/v1/heartbeats',
      headers: { authorization: `Bearer ${oldToken}` },
      payload: {
        heartbeats: [{ occurred_at: new Date().toISOString(), screen_on_count: 1 }],
      },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('device_deactivated');
  });

  it('ログイン後、新デバイストークンでハートビートが送れる', async () => {
    const { token: wToken } = await createWatcher();
    const { deviceToken } = await createClientViaProvisioning(wToken);
    const email = testEmail();

    // メール登録 + ログイン
    await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email, password: 'securepass123' },
    });
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/clients/login',
      payload: {
        email,
        password: 'securepass123',
        platform: 'ios',
        consent_version: '2.0',
      },
    });
    const newToken = JSON.parse(loginRes.body).device_token;

    // 新トークンでハートビート → 200
    const hbRes = await app.inject({
      method: 'POST',
      url: '/v1/heartbeats',
      headers: { authorization: `Bearer ${newToken}` },
      payload: {
        heartbeats: [{ occurred_at: new Date().toISOString(), screen_on_count: 1 }],
      },
    });

    expect(hbRes.statusCode).toBe(200);
    const hbBody = JSON.parse(hbRes.body);
    expect(hbBody.accepted).toBe(1);
  });

  it('consent_version が更新される', async () => {
    const { token: wToken } = await createWatcher();
    const { clientId, deviceToken } = await createClientViaProvisioning(wToken);
    const email = testEmail();

    await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email, password: 'securepass123' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/clients/login',
      payload: {
        email,
        password: 'securepass123',
        platform: 'ios',
        consent_version: '3.0',
      },
    });

    const dbRes = await query<{ consent_version: string }>(
      'SELECT consent_version FROM clients WHERE id = $1',
      [clientId],
    );
    expect(dbRes.rows[0]!.consent_version).toBe('3.0');
  });

  it('audit_log に client_device_login が記録される', async () => {
    const { token: wToken } = await createWatcher();
    const { clientId, deviceToken } = await createClientViaProvisioning(wToken);
    const email = testEmail();

    await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email, password: 'securepass123' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/clients/login',
      payload: {
        email,
        password: 'securepass123',
        platform: 'ios',
        app_version: '1.2.0',
        consent_version: '2.0',
      },
    });

    const logRes = await query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log WHERE client_id = $1 AND event = 'client_device_login'
       ORDER BY created_at DESC LIMIT 1`,
      [clientId],
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0]!.detail).toMatchObject({
      platform: 'ios',
      consent_version: '2.0',
    });
  });

  it('メール未登録のクライアントにはログインできない（401）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/login',
      payload: {
        email: 'nonexistent@example.com',
        password: 'securepass123',
        platform: 'ios',
        consent_version: '1.0',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_credentials');
  });

  it('パスワード間違い → 401', async () => {
    const { token: wToken } = await createWatcher();
    const { deviceToken } = await createClientViaProvisioning(wToken);
    const email = testEmail();

    await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email, password: 'securepass123' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/login',
      payload: {
        email,
        password: 'wrongpassword',
        platform: 'ios',
        consent_version: '1.0',
      },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('クロスロール メール共有', () => {
  it('watchers と clients で同一メールが登録できる', async () => {
    const sharedEmail = testEmail();

    // ウォッチャーとして登録
    const wRes = await app.inject({
      method: 'POST',
      url: '/v1/watchers',
      payload: { display_name: 'テスト', email: sharedEmail, password: 'password1234' },
    });
    expect(wRes.statusCode).toBe(201);
    createdWatcherIds.push(JSON.parse(wRes.body).watcher_id);

    // クライアントとしてもメール登録
    const { token: wToken } = await createWatcher();
    const { deviceToken } = await createClientViaProvisioning(wToken);

    const ceRes = await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email: sharedEmail, password: 'securepass123' },
    });
    expect(ceRes.statusCode).toBe(200);
  });
});

describe('watch_links の継続', () => {
  it('ログイン後も watch_links が維持される', async () => {
    const { token: wToken, watcherId } = await createWatcher();
    const { clientId, deviceToken } = await createClientViaProvisioning(wToken);
    const email = testEmail();

    // メール登録
    await app.inject({
      method: 'POST',
      url: '/v1/clients/me/email',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { email, password: 'securepass123' },
    });

    // ログイン（機種変更シミュレーション）
    await app.inject({
      method: 'POST',
      url: '/v1/clients/login',
      payload: {
        email,
        password: 'securepass123',
        platform: 'ios',
        consent_version: '2.0',
      },
    });

    // watch_links が維持されている
    const wlRes = await query(
      'SELECT 1 FROM watch_links WHERE watcher_id = $1 AND client_id = $2',
      [watcherId, clientId],
    );
    expect(wlRes.rowCount).toBe(1);
  });
});
