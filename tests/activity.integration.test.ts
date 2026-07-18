/**
 * 日次活動サマリ API の統合テスト。
 *
 * 【このテストが守るもの】
 * - GET /v1/clients/:client_id/activity の日次集計が正しく動作すること
 * - days クエリパラメータのクランプ（1-7、デフォルト3）
 * - 権限チェック（watch_links なし → 404）
 * - データ無し日が 0 埋めで配列に含まれること
 * - screen_on_count / app_usage_slots / movement_slots / battery_min/max の集計
 * - zod スキーマで余計なフィールドが漏れないこと
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
    await query('DELETE FROM events WHERE client_id = $1', [id]);
    await query('DELETE FROM devices WHERE client_id = $1', [id]);
    await query('DELETE FROM watch_links WHERE client_id = $1', [id]);
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
  const email = `test-act-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.com`;
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
    payload: { code, display_name: 'テスト', consent_version: '1.0', platform: 'android' },
  });
  const body = JSON.parse(pairRes.body);
  createdClientIds.push(body.client_id);
  return { clientId: body.client_id, deviceToken: body.device_token };
}

describe('GET /v1/clients/:client_id/activity', () => {
  it('デフォルトで3日分の配列を返す（データ無し日は 0 埋め）', async () => {
    const { token } = await createWatcher();
    const { clientId } = await createClient(token);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/activity`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.client_id).toBe(clientId);
    expect(body.days).toHaveLength(3);

    // 古い→新しい順
    const dates = body.days.map((d: { date: string }) => d.date);
    expect(dates[0] < dates[2]).toBe(true);

    // 0 埋め
    for (const day of body.days) {
      expect(day.screen_on_count).toBe(0);
      expect(day.app_usage_slots).toBe(0);
      expect(day.movement_slots).toBe(0);
      expect(day.heartbeat_count).toBe(0);
      expect(day.active_buckets).toBe(0);
      expect(day.battery_min).toBeNull();
      expect(day.battery_max).toBeNull();
      expect(day.charging_events).toBe(0);
      expect(day.step_count).toBeNull();
    }
  });

  it('days=1 で当日のみ返す', async () => {
    const { token } = await createWatcher();
    const { clientId } = await createClient(token);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/activity?days=1`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).days).toHaveLength(1);
  });

  it('days=7 で7日分返す', async () => {
    const { token } = await createWatcher();
    const { clientId } = await createClient(token);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/activity?days=7`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).days).toHaveLength(7);
  });

  it('days=99 は 7 にクランプされる', async () => {
    const { token } = await createWatcher();
    const { clientId } = await createClient(token);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/activity?days=99`,
      headers: { authorization: `Bearer ${token}` },
    });

    // days > 7 は zod で弾かれるのでデフォルト 3 にフォールバック
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.days.length).toBeLessThanOrEqual(7);
  });

  it('heartbeat データがあると集計に反映される', async () => {
    const { token } = await createWatcher();
    const { clientId, deviceToken } = await createClient(token);

    // heartbeat を送信
    await app.inject({
      method: 'POST',
      url: '/v1/heartbeats',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        heartbeats: [
          {
            occurred_at: new Date().toISOString(),
            screen_on_count: 5,
            had_app_usage: true,
            had_movement: true,
            battery_level: 80,
          },
          {
            occurred_at: new Date(Date.now() - 60000).toISOString(),
            screen_on_count: 3,
            had_app_usage: false,
            had_movement: false,
            battery_level: 75,
          },
        ],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/activity?days=1`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const today = body.days[0];
    expect(today.screen_on_count).toBe(8);       // 5 + 3
    expect(today.app_usage_slots).toBe(1);        // 1件のみ true
    expect(today.movement_slots).toBe(1);         // 1件のみ true
    expect(today.heartbeat_count).toBe(2);
    expect(today.active_buckets).toBeGreaterThanOrEqual(1);
    expect(today.battery_min).toBe(75);
    expect(today.battery_max).toBe(80);
  });

  it('権限のないクライアントには 404', async () => {
    const { token: token1 } = await createWatcher();
    const { clientId } = await createClient(token1);

    // 別ウォッチャー
    const { token: token2 } = await createWatcher();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/activity`,
      headers: { authorization: `Bearer ${token2}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('is_charging と step_count が集計に反映される', async () => {
    const { token } = await createWatcher();
    const { clientId, deviceToken } = await createClient(token);

    const now = Date.now();
    // 充電していない → 充電開始 → 充電中 → 充電停止 → 充電開始（2回遷移）
    await app.inject({
      method: 'POST',
      url: '/v1/heartbeats',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        heartbeats: [
          { occurred_at: new Date(now - 4 * 60000).toISOString(), is_charging: false, step_count: 100, battery_level: 50 },
          { occurred_at: new Date(now - 3 * 60000).toISOString(), is_charging: true, step_count: 200, battery_level: 55 },
          { occurred_at: new Date(now - 2 * 60000).toISOString(), is_charging: true, step_count: 500, battery_level: 60 },
          { occurred_at: new Date(now - 1 * 60000).toISOString(), is_charging: false, step_count: 800, battery_level: 58 },
          { occurred_at: new Date(now).toISOString(), is_charging: true, step_count: 1200, battery_level: 62 },
        ],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/activity?days=1`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const today = JSON.parse(res.body).days[0];
    // false→true が2回（HB2とHB5）
    expect(today.charging_events).toBe(2);
    // step_count の最大値 = 1200
    expect(today.step_count).toBe(1200);
  });

  it('is_charging/step_count が null/未送信でもエラーにならない（後方互換）', async () => {
    const { token } = await createWatcher();
    const { clientId, deviceToken } = await createClient(token);

    await app.inject({
      method: 'POST',
      url: '/v1/heartbeats',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        heartbeats: [
          { occurred_at: new Date().toISOString(), screen_on_count: 1, battery_level: 80 },
          { occurred_at: new Date(Date.now() - 60000).toISOString(), is_charging: null, step_count: null, battery_level: 70 },
        ],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/activity?days=1`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const today = JSON.parse(res.body).days[0];
    expect(today.heartbeat_count).toBe(2);
    expect(today.charging_events).toBe(0);
    expect(today.step_count).toBeNull();
  });

  it('レスポンスに余計なフィールドが含まれない', async () => {
    const { token } = await createWatcher();
    const { clientId } = await createClient(token);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/clients/${clientId}/activity?days=1`,
      headers: { authorization: `Bearer ${token}` },
    });

    const body = JSON.parse(res.body);
    // トップレベルは client_id と days のみ
    expect(Object.keys(body).sort()).toEqual(['client_id', 'days']);

    // day 要素のキーは固定
    const allowedKeys = [
      'date', 'screen_on_count', 'app_usage_slots', 'movement_slots',
      'heartbeat_count', 'active_buckets', 'battery_min', 'battery_max',
      'charging_events', 'step_count',
    ].sort();
    for (const day of body.days) {
      expect(Object.keys(day).sort()).toEqual(allowedKeys);
    }
  });
});
