/**
 * 逆方向ペアリング（provision → poll → claim）の統合テスト。
 *
 * 【このテストが守るもの】
 * - provision → ポーリング → claim → device_token 取得のフルフロー
 * - claim_code / fallback_code の両方で claim できること
 * - claim 前のポーリングが { claimed: false } を返すこと
 * - 期限切れ・claim 済みのエラーハンドリング
 * - 認証なしエンドポイントに JWT を要求しないこと
 * - ウォッチャー認証なしの claim が拒否されること
 *
 * 前提: DATABASE_URL のDBにマイグレーション済みであること。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { setFcmDriver, type FcmDriver, type PushRequest } from '../src/notify/fcm.js';

class NoOpFcmDriver implements FcmDriver {
  public sent: PushRequest[] = [];
  async send(req: PushRequest) {
    this.sent.push(req);
    return { ok: true };
  }
  reset() {
    this.sent = [];
  }
}

const fcm = new NoOpFcmDriver();
setFcmDriver(fcm);

let app: FastifyInstance;
let watcherToken: string;
let watcherId: string;

/** テストで作成した provision の ID を記録（クリーンアップ用） */
const createdProvisionIds: string[] = [];
const createdClientIds: string[] = [];

async function registerWatcher(): Promise<void> {
  const email = `prov-test-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/watchers',
    payload: { display_name: 'テスト見守り', email, password: 'password1234' },
  });
  const body = res.json();
  watcherToken = body.access_token;
  watcherId = body.watcher_id;
}

/** provision を作成してレスポンスを返す */
async function createProvision(overrides?: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/provisions',
    payload: {
      platform: 'android',
      consent_version: 'v1.0',
      ...overrides,
    },
  });
  if (res.statusCode === 201) {
    createdProvisionIds.push(res.json().provision_id);
  }
  return res;
}

beforeEach(async () => {
  app = await buildApp();
  fcm.reset();
  await registerWatcher();
});

afterEach(async () => {
  // クリーンアップ（依存関係の順序に注意）
  for (const clientId of createdClientIds) {
    await query('DELETE FROM events WHERE client_id = $1', [clientId]);
    await query('DELETE FROM sos_incidents WHERE client_id = $1', [clientId]);
    await query('DELETE FROM audit_log WHERE client_id = $1', [clientId]);
  }
  for (const provId of createdProvisionIds) {
    await query('DELETE FROM provisions WHERE id = $1', [provId]);
  }
  for (const clientId of createdClientIds) {
    await query('DELETE FROM clients WHERE id = $1', [clientId]);
  }
  if (watcherId) await query('DELETE FROM watchers WHERE id = $1', [watcherId]);
  createdProvisionIds.length = 0;
  createdClientIds.length = 0;
  await app.close();
});

afterAll(async () => {
  await closePool();
});

describe('POST /v1/provisions — 端末の自己登録', () => {
  it('認証なしで 201 を返し、必要なフィールドが全て含まれる', async () => {
    const res = await createProvision();
    expect(res.statusCode).toBe(201);
    const body = res.json();

    expect(body.provision_id).toBeDefined();
    expect(typeof body.claim_code).toBe('string');
    expect(body.claim_code.length).toBeGreaterThan(20); // QR 用の長い文字列
    expect(body.fallback_code).toMatch(/^\d{6}$/); // 6桁数字
    expect(typeof body.claim_secret).toBe('string');
    expect(body.claim_secret).not.toBe(body.claim_code); // 別値
    expect(body.expires_in_minutes).toBe(30);
  });

  it('consent_version が無いと 400 になる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/provisions',
      payload: { platform: 'android' }, // consent_version なし
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('platform が無いと 400 になる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/provisions',
      payload: { consent_version: 'v1.0' }, // platform なし
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/provisions/me — ポーリング', () => {
  it('claim 前は { claimed: false } を返す', async () => {
    const provRes = await createProvision();
    const { claim_secret } = provRes.json();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/provisions/me',
      headers: { authorization: `Bearer ${claim_secret}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ claimed: false });
  });

  it('Authorization がないと 401 になる', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/provisions/me',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('不正な claim_secret では 404 になる', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/provisions/me',
      headers: { authorization: 'Bearer invalid-secret-12345' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/clients/claim — ウォッチャーが claim', () => {
  it('claim_code で claim → ポーリングで device_token を取得できる（フルフロー）', async () => {
    // 1. provision
    const provRes = await createProvision({ fcm_token: 'test-device-fcm' });
    const { claim_code, claim_secret, provision_id } = provRes.json();

    // 2. ポーリング（まだ claim されていない）
    const pollBefore = await app.inject({
      method: 'GET',
      url: '/v1/provisions/me',
      headers: { authorization: `Bearer ${claim_secret}` },
    });
    expect(pollBefore.json().claimed).toBe(false);

    // 3. claim
    const claimRes = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { code: claim_code, display_name: 'おばあちゃん' },
    });
    expect(claimRes.statusCode).toBe(201);
    const { client_id } = claimRes.json();
    expect(client_id).toBeDefined();
    createdClientIds.push(client_id);

    // 4. ポーリング（claim 済み → device_token が返る）
    const pollAfter = await app.inject({
      method: 'GET',
      url: '/v1/provisions/me',
      headers: { authorization: `Bearer ${claim_secret}` },
    });
    expect(pollAfter.statusCode).toBe(200);
    const pollBody = pollAfter.json();
    expect(pollBody.claimed).toBe(true);
    expect(pollBody.client_id).toBe(client_id);
    expect(typeof pollBody.device_token).toBe('string');
    expect(pollBody.device_token.length).toBeGreaterThan(10);

    // 5. 取得した device_token でハートビートを送れることを確認
    const hbRes = await app.inject({
      method: 'POST',
      url: '/v1/heartbeats',
      headers: { authorization: `Bearer ${pollBody.device_token}` },
      payload: {
        heartbeats: [
          { occurred_at: new Date().toISOString(), screen_on_count: 5, had_app_usage: true },
        ],
      },
    });
    expect(hbRes.statusCode).toBe(200);
  });

  it('fallback_code（6桁）でも claim できる', async () => {
    const provRes = await createProvision();
    const { fallback_code, claim_secret } = provRes.json();

    const claimRes = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { code: fallback_code, display_name: 'おじいちゃん' },
    });
    expect(claimRes.statusCode).toBe(201);
    createdClientIds.push(claimRes.json().client_id);

    // ポーリングで確認
    const poll = await app.inject({
      method: 'GET',
      url: '/v1/provisions/me',
      headers: { authorization: `Bearer ${claim_secret}` },
    });
    expect(poll.json().claimed).toBe(true);
    expect(typeof poll.json().device_token).toBe('string');
  });

  it('claim 済みのコードを再度 claim すると 409 already_claimed', async () => {
    const provRes = await createProvision();
    const { claim_code } = provRes.json();

    // 1回目: 成功
    const first = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { code: claim_code, display_name: '最初の登録' },
    });
    expect(first.statusCode).toBe(201);
    createdClientIds.push(first.json().client_id);

    // 2回目: 409
    const second = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { code: claim_code, display_name: '二重登録' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('already_claimed');
  });

  it('不正なコードでは 400 invalid_code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { code: 'invalid-code-12345', display_name: 'テスト' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_code');
  });

  it('ウォッチャー認証なしの claim は 401', async () => {
    const provRes = await createProvision();
    const { claim_code } = provRes.json();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      payload: { code: claim_code, display_name: 'テスト' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('display_name が無いと 400 になる', async () => {
    const provRes = await createProvision();
    const { claim_code } = provRes.json();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { code: claim_code }, // display_name なし
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('claim 時に監査ログが記録される（consent_version を含む）', async () => {
    const provRes = await createProvision({ consent_version: 'v2.1' });
    const { claim_code } = provRes.json();

    const claimRes = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { code: claim_code, display_name: '監査テスト' },
    });
    expect(claimRes.statusCode).toBe(201);
    const clientId = claimRes.json().client_id;
    createdClientIds.push(clientId);

    // 監査ログの確認
    const logRes = await query<{ event: string; detail: Record<string, unknown> }>(
      `SELECT event, detail FROM audit_log
       WHERE client_id = $1 AND event = 'client_claimed'
       ORDER BY created_at DESC LIMIT 1`,
      [clientId],
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0]!.detail.consent_version).toBe('v2.1');
    expect(logRes.rows[0]!.detail.watcher_id).toBe(watcherId);
  });
});

describe('期限切れ provision', () => {
  it('期限切れの provision を claim すると invalid_code', async () => {
    const provRes = await createProvision();
    const { claim_code, provision_id } = provRes.json();

    // 強制的に期限切れにする
    await query('UPDATE provisions SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [
      provision_id,
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { code: claim_code, display_name: 'テスト' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_code');
  });

  it('期限切れの provision をポーリングすると expired', async () => {
    const provRes = await createProvision();
    const { claim_secret, provision_id } = provRes.json();

    await query('UPDATE provisions SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [
      provision_id,
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/provisions/me',
      headers: { authorization: `Bearer ${claim_secret}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('expired');
  });
});
