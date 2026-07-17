/**
 * 追加ウォッチャー招待（多対多ペアリング）の統合テスト。
 *
 * 【このテストが守るもの】
 * - 既存クライアントに追加ウォッチャーを紐づけるフルフロー
 * - invite_code / fallback_code の両方で join 可能
 * - join 済みコードの再利用は 409
 * - 既に紐づき済みの watcher の二重 join は 409
 * - ポーリング（GET /v1/invite-codes/:id）で join 状態を確認
 * - GET /v1/clients/me/watchers で見守り人一覧を取得
 * - 期限切れコードは 404
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
let watcher1Token: string;
let watcher1Id: string;
let watcher2Token: string;
let watcher2Id: string;
let deviceToken: string;
let clientId: string;

async function registerWatcher(name: string): Promise<{ token: string; id: string }> {
  const email = `inv-test-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.test`;
  const res = await app.inject({
    method: 'POST', url: '/v1/watchers',
    payload: { display_name: name, email, password: 'password1234' },
  });
  const body = res.json();
  return { token: body.access_token, id: body.watcher_id };
}

async function pairClient(watcherToken: string): Promise<{ clientId: string; deviceToken: string }> {
  const codeRes = await app.inject({
    method: 'POST', url: '/v1/pairing-codes',
    headers: { authorization: `Bearer ${watcherToken}` },
  });
  const pairRes = await app.inject({
    method: 'POST', url: '/v1/clients/pair',
    payload: {
      code: codeRes.json().code, display_name: 'テスト親',
      consent_version: 'v1.0', platform: 'android',
    },
  });
  const body = pairRes.json();
  return { clientId: body.client_id, deviceToken: body.device_token };
}

beforeEach(async () => {
  app = await buildApp();
  fcm.reset();
  const w1 = await registerWatcher('子供1');
  watcher1Token = w1.token; watcher1Id = w1.id;
  const w2 = await registerWatcher('子供2');
  watcher2Token = w2.token; watcher2Id = w2.id;
  const paired = await pairClient(watcher1Token);
  clientId = paired.clientId; deviceToken = paired.deviceToken;
});

afterEach(async () => {
  if (clientId) {
    await query('DELETE FROM invite_codes WHERE client_id = $1', [clientId]);
    await query('DELETE FROM stamps WHERE client_id = $1', [clientId]);
    await query('DELETE FROM events WHERE client_id = $1', [clientId]);
    await query('DELETE FROM audit_log WHERE client_id = $1', [clientId]);
    await query('DELETE FROM clients WHERE id = $1', [clientId]);
  }
  if (watcher1Id) await query('DELETE FROM watchers WHERE id = $1', [watcher1Id]);
  if (watcher2Id) await query('DELETE FROM watchers WHERE id = $1', [watcher2Id]);
  await app.close();
});

afterAll(async () => {
  await closePool();
});

describe('POST /v1/invite-codes — 招待コード発行', () => {
  it('201 で必要なフィールドを返す', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.invite_id).toBeDefined();
    expect(body.invite_code.length).toBeGreaterThan(20);
    expect(body.fallback_code).toMatch(/^\d{6}$/);
    expect(body.expires_in_minutes).toBe(30);
  });

  it('ウォッチャー認証では 403', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${watcher1Token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/clients/join — フルフロー', () => {
  it('invite_code で join → ポーリングで確認 → watchers 一覧に反映', async () => {
    // 1. 招待コード発行
    const invRes = await app.inject({
      method: 'POST', url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const { invite_id, invite_code } = invRes.json();

    // 2. ポーリング（join 前）
    const pollBefore = await app.inject({
      method: 'GET', url: `/v1/invite-codes/${invite_id}`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(pollBefore.json()).toEqual({ joined: false });

    // 3. watcher2 が join
    const joinRes = await app.inject({
      method: 'POST', url: '/v1/clients/join',
      headers: { authorization: `Bearer ${watcher2Token}` },
      payload: { code: invite_code, display_name: 'テスト親' },
    });
    expect(joinRes.statusCode).toBe(201);
    expect(joinRes.json().client_id).toBe(clientId);

    // 4. ポーリング（join 後）
    const pollAfter = await app.inject({
      method: 'GET', url: `/v1/invite-codes/${invite_id}`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const pollBody = pollAfter.json();
    expect(pollBody.joined).toBe(true);
    expect(pollBody.watcher_name).toBe('子供2');

    // 5. watchers 一覧に2人表示
    const listRes = await app.inject({
      method: 'GET', url: '/v1/clients/me/watchers',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const names = listRes.json().map((w: { display_name: string }) => w.display_name);
    expect(names).toContain('子供1');
    expect(names).toContain('子供2');
    expect(names).toHaveLength(2);
  });

  it('fallback_code（6桁）でも join できる', async () => {
    const invRes = await app.inject({
      method: 'POST', url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const { fallback_code } = invRes.json();

    const joinRes = await app.inject({
      method: 'POST', url: '/v1/clients/join',
      headers: { authorization: `Bearer ${watcher2Token}` },
      payload: { code: fallback_code, display_name: 'テスト親' },
    });
    expect(joinRes.statusCode).toBe(201);
  });

  it('join 済みコードの再利用は 409 already_used', async () => {
    const invRes = await app.inject({
      method: 'POST', url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const { invite_code } = invRes.json();

    // 1回目: 成功
    await app.inject({
      method: 'POST', url: '/v1/clients/join',
      headers: { authorization: `Bearer ${watcher2Token}` },
      payload: { code: invite_code, display_name: 'テスト' },
    });

    // 2回目: 409（別の watcher でも）
    const w3 = await registerWatcher('子供3');
    const res = await app.inject({
      method: 'POST', url: '/v1/clients/join',
      headers: { authorization: `Bearer ${w3.token}` },
      payload: { code: invite_code, display_name: 'テスト' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_used');
    await query('DELETE FROM watchers WHERE id = $1', [w3.id]);
  });

  it('既に紐づき済みの watcher は 409 already_joined', async () => {
    const invRes = await app.inject({
      method: 'POST', url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const { invite_code } = invRes.json();

    // watcher1 は既にペアリング済み
    const res = await app.inject({
      method: 'POST', url: '/v1/clients/join',
      headers: { authorization: `Bearer ${watcher1Token}` },
      payload: { code: invite_code, display_name: 'テスト親' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_joined');
  });

  it('不正なコードは 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/clients/join',
      headers: { authorization: `Bearer ${watcher2Token}` },
      payload: { code: 'invalid-code-xyz', display_name: 'テスト' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('認証なしの join は 401', async () => {
    const invRes = await app.inject({
      method: 'POST', url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/clients/join',
      payload: { code: invRes.json().invite_code, display_name: 'テスト' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('期限切れ invite', () => {
  it('期限切れのコードで join すると 404', async () => {
    const invRes = await app.inject({
      method: 'POST', url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const { invite_code, invite_id } = invRes.json();

    // 強制的に期限切れ
    await query("UPDATE invite_codes SET expires_at = now() - interval '1 hour' WHERE id = $1", [invite_id]);

    const res = await app.inject({
      method: 'POST', url: '/v1/clients/join',
      headers: { authorization: `Bearer ${watcher2Token}` },
      payload: { code: invite_code, display_name: 'テスト' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/clients/me/watchers — 見守り人一覧', () => {
  it('ペアリング直後は1人のみ', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/clients/me/watchers',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].display_name).toBe('子供1');
    // 最小開示: display_name のみ（ID 等は含まない）
    expect(Object.keys(body[0])).toEqual(['display_name']);
  });
});

describe('join 時の監査ログ', () => {
  it('watcher_joined が記録される', async () => {
    const invRes = await app.inject({
      method: 'POST', url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    await app.inject({
      method: 'POST', url: '/v1/clients/join',
      headers: { authorization: `Bearer ${watcher2Token}` },
      payload: { code: invRes.json().invite_code, display_name: 'テスト親' },
    });

    const logRes = await query<{ event: string; detail: Record<string, unknown> }>(
      `SELECT event, detail FROM audit_log
       WHERE client_id = $1 AND event = 'watcher_joined'
       ORDER BY created_at DESC LIMIT 1`,
      [clientId],
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0]!.detail.watcher_id).toBe(watcher2Id);
  });
});
