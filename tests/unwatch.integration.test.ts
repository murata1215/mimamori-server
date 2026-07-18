/**
 * 見守り紐づけ解除 (DELETE /v1/clients/:client_id) の統合テスト。
 *
 * 【このテストが守るもの】
 * - 自分の watch_link のみ削除される
 * - 他ウォッチャーの watch_link は残る
 * - client レコードは削除されない
 * - 解除後 GET /v1/clients から消える
 * - 解除後 GET /v1/clients/me/watchers から該当ウォッチャーが消える
 * - 権限なし / 存在しない場合は 404
 * - 冪等性: 既に解除済みなら 404
 * - audit_log に watch_link_removed が記録される
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
const createdWatcherIds: string[] = [];
const createdClientIds: string[] = [];

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

async function createWatcher(): Promise<{ watcherId: string; token: string }> {
  const email = `test-uw-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/watchers',
    payload: { display_name: 'テストW', email, password: 'password1234' },
  });
  const body = JSON.parse(res.body);
  createdWatcherIds.push(body.watcher_id);
  return { watcherId: body.watcher_id, token: body.access_token };
}

async function createClient(watcherToken: string): Promise<{
  clientId: string;
  deviceToken: string;
}> {
  const codeRes = await app.inject({
    method: 'POST',
    url: '/v1/pairing-codes',
    headers: { authorization: `Bearer ${watcherToken}` },
  });
  const { code } = JSON.parse(codeRes.body);
  const pairRes = await app.inject({
    method: 'POST',
    url: '/v1/clients/pair',
    payload: { code, display_name: 'テスト高齢者', consent_version: '1.0', platform: 'android' },
  });
  const body = JSON.parse(pairRes.body);
  createdClientIds.push(body.client_id);
  return { clientId: body.client_id, deviceToken: body.device_token };
}

describe('DELETE /v1/clients/:client_id — 見守り解除', () => {
  it('自分の watch_link を解除でき 200 が返る', async () => {
    const { token } = await createWatcher();
    const { clientId } = await createClient(token);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/clients/${clientId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('解除後 GET /v1/clients の一覧から消える', async () => {
    const { token } = await createWatcher();
    const { clientId } = await createClient(token);

    await app.inject({
      method: 'DELETE',
      url: `/v1/clients/${clientId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/clients',
      headers: { authorization: `Bearer ${token}` },
    });

    const clients = JSON.parse(listRes.body);
    expect(clients.find((c: { id: string }) => c.id === clientId)).toBeUndefined();
  });

  it('解除後 GET /v1/clients/me/watchers から該当ウォッチャーが消える', async () => {
    const { token: wToken, watcherId } = await createWatcher();
    const { clientId, deviceToken } = await createClient(wToken);

    // 解除前: ウォッチャーが見える
    const beforeRes = await app.inject({
      method: 'GET',
      url: '/v1/clients/me/watchers',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(JSON.parse(beforeRes.body).length).toBeGreaterThanOrEqual(1);

    // 解除
    await app.inject({
      method: 'DELETE',
      url: `/v1/clients/${clientId}`,
      headers: { authorization: `Bearer ${wToken}` },
    });

    // 解除後: 空になる
    const afterRes = await app.inject({
      method: 'GET',
      url: '/v1/clients/me/watchers',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(JSON.parse(afterRes.body)).toEqual([]);
  });

  it('権限のないクライアントには 404', async () => {
    const { token: token1 } = await createWatcher();
    const { clientId } = await createClient(token1);

    const { token: token2 } = await createWatcher();

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/clients/${clientId}`,
      headers: { authorization: `Bearer ${token2}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('冪等性: 既に解除済みなら 404', async () => {
    const { token } = await createWatcher();
    const { clientId } = await createClient(token);

    // 1回目: 200
    const res1 = await app.inject({
      method: 'DELETE',
      url: `/v1/clients/${clientId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res1.statusCode).toBe(200);

    // 2回目: 404
    const res2 = await app.inject({
      method: 'DELETE',
      url: `/v1/clients/${clientId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res2.statusCode).toBe(404);
  });

  it('他ウォッチャーの watch_link は残る', async () => {
    const { token: token1, watcherId: watcher1 } = await createWatcher();
    const { clientId } = await createClient(token1);

    // 2人目のウォッチャーを招待で追加
    const { token: token2, watcherId: watcher2 } = await createWatcher();
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/v1/invite-codes',
      headers: { authorization: `Bearer ${await getDeviceToken(token1, clientId)}` },
    });
    const { invite_code } = JSON.parse(inviteRes.body);
    const joinRes = await app.inject({
      method: 'POST',
      url: '/v1/clients/join',
      headers: { authorization: `Bearer ${token2}` },
      payload: { code: invite_code, display_name: 'テスト高齢者' },
    });
    // join が成功していることを確認
    expect(joinRes.statusCode).toBe(201);

    // watcher1 が解除
    await app.inject({
      method: 'DELETE',
      url: `/v1/clients/${clientId}`,
      headers: { authorization: `Bearer ${token1}` },
    });

    // watcher2 の watch_link は残っている
    const wlRes = await query(
      'SELECT 1 FROM watch_links WHERE watcher_id = $1 AND client_id = $2',
      [watcher2, clientId],
    );
    expect(wlRes.rowCount).toBe(1);

    // watcher1 の watch_link は削除されている
    const wl1Res = await query(
      'SELECT 1 FROM watch_links WHERE watcher_id = $1 AND client_id = $2',
      [watcher1, clientId],
    );
    expect(wl1Res.rowCount).toBe(0);
  });

  it('client レコードは削除されない', async () => {
    const { token } = await createWatcher();
    const { clientId } = await createClient(token);

    await app.inject({
      method: 'DELETE',
      url: `/v1/clients/${clientId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const clientRes = await query('SELECT 1 FROM clients WHERE id = $1', [clientId]);
    expect(clientRes.rowCount).toBe(1);
  });

  it('audit_log に watch_link_removed が記録される', async () => {
    const { token, watcherId } = await createWatcher();
    const { clientId } = await createClient(token);

    await app.inject({
      method: 'DELETE',
      url: `/v1/clients/${clientId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const logRes = await query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log WHERE client_id = $1 AND event = 'watch_link_removed'
       ORDER BY created_at DESC LIMIT 1`,
      [clientId],
    );
    expect(logRes.rows.length).toBe(1);
    expect(logRes.rows[0]!.detail).toMatchObject({ watcher_id: watcherId });
  });
});

/** ヘルパー: clientId から device_token を取得（invite-codes 発行に必要） */
async function getDeviceToken(watcherToken: string, clientId: string): Promise<string> {
  // 既存のペアリングで作られた device_token を DB から取得して JWT を発行し直すのは面倒なので
  // 新たにペアリングして同じ watcher に紐づく別の client を作る代わりに、
  // 直接 DB から device_id を取得して JWT を発行する
  const { issueDeviceToken } = await import('../src/auth/jwt.js');
  const devRes = await query<{ id: string }>(
    'SELECT id FROM devices WHERE client_id = $1 AND deactivated_at IS NULL LIMIT 1',
    [clientId],
  );
  return issueDeviceToken(app, clientId, devRes.rows[0]!.id);
}
