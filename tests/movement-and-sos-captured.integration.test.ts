/**
 * 移動有無シグナル + SOS キャッシュ位置フォールバックの統合テスト。
 *
 * 【このテストが守るもの】
 * - had_movement: true が生存イベント扱いされること（デッドマンスイッチのリセット）
 * - had_movement: false / 省略は生存イベントにならないこと
 * - location_captured_at が sos_incidents に保存されること
 * - SOS 詳細レスポンスに location_captured_at が含まれること
 * - location_captured_at 省略時は null
 * - 既存の screen_on_count / had_app_usage は動作不変
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { setFcmDriver, type FcmDriver, type PushRequest } from '../src/notify/fcm.js';
import { isAliveEvent, type IngestEvent } from '../src/engine/events.js';

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
    await query('DELETE FROM sos_incidents WHERE client_id = $1', [id]);
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
  const email = `test-mv-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.com`;
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

function makeEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    clientId: '00000000-0000-0000-0000-000000000001',
    sourceType: 'phone',
    eventType: 'heartbeat',
    occurredAt: new Date(),
    ...overrides,
  };
}

// =============================================================================
// had_movement — 生存判定の単体テスト
// =============================================================================
describe('isAliveEvent — had_movement', () => {
  it('had_movement: true は生存イベント', () => {
    expect(isAliveEvent(makeEvent({ meta: { had_movement: true } }))).toBe(true);
  });

  it('had_movement: false は生存イベントではない', () => {
    expect(isAliveEvent(makeEvent({ meta: { had_movement: false } }))).toBe(false);
  });

  it('had_movement 省略（既存ペイロード互換）は生存イベントではない', () => {
    expect(isAliveEvent(makeEvent({ meta: { screen_on_count: 0 } }))).toBe(false);
  });

  it('had_movement: true + screen_on_count: 0 は生存イベント', () => {
    expect(isAliveEvent(makeEvent({ meta: { screen_on_count: 0, had_movement: true } }))).toBe(true);
  });

  it('screen_on_count: 1 + had_movement: false は生存イベント（screen_on が優先）', () => {
    expect(isAliveEvent(makeEvent({ meta: { screen_on_count: 1, had_movement: false } }))).toBe(true);
  });
});

// =============================================================================
// had_movement — 統合テスト（heartbeat API）
// =============================================================================
describe('POST /v1/heartbeats with had_movement', () => {
  it('had_movement: true で revived が返る', async () => {
    const { token: wToken } = await createWatcher();
    const { clientId, deviceToken } = await createClient(wToken);

    // 閾値超過をシミュレート → WATCH へ遷移
    await query(
      `UPDATE clients SET status = 'WATCH', status_changed_at = now(), last_alive_event_at = now() - interval '20 hours' WHERE id = $1`,
      [clientId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/heartbeats',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        heartbeats: [{
          occurred_at: new Date().toISOString(),
          had_movement: true,
          screen_on_count: 0,
          had_app_usage: false,
        }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBe(1);
    expect(body.revived).toBe(true);
  });

  it('had_movement: false のみでは revived しない', async () => {
    const { token: wToken } = await createWatcher();
    const { clientId, deviceToken } = await createClient(wToken);

    await query(
      `UPDATE clients SET status = 'WATCH', status_changed_at = now(), last_alive_event_at = now() - interval '20 hours' WHERE id = $1`,
      [clientId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/heartbeats',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        heartbeats: [{
          occurred_at: new Date().toISOString(),
          had_movement: false,
          screen_on_count: 0,
        }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).revived).toBe(false);
  });

  it('had_movement 省略は既存互換（screen_on_count: 0 なら revived しない）', async () => {
    const { token: wToken } = await createWatcher();
    const { clientId, deviceToken } = await createClient(wToken);

    await query(
      `UPDATE clients SET status = 'WATCH', status_changed_at = now(), last_alive_event_at = now() - interval '20 hours' WHERE id = $1`,
      [clientId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/heartbeats',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        heartbeats: [{
          occurred_at: new Date().toISOString(),
          screen_on_count: 0,
        }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).revived).toBe(false);
  });
});

// =============================================================================
// SOS — location_captured_at
// =============================================================================
describe('POST /v1/sos with location_captured_at', () => {
  it('location_captured_at が sos_incidents に保存される', async () => {
    const { token: wToken } = await createWatcher();
    const { clientId, deviceToken } = await createClient(wToken);
    const capturedAt = '2026-07-18T00:30:00.000Z';

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sos',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { lat: 35.68, lng: 139.77, location_captured_at: capturedAt },
    });

    expect(res.statusCode).toBe(201);
    const { incident_id } = JSON.parse(res.body);

    const dbRes = await query<{ location_captured_at: Date }>(
      'SELECT location_captured_at FROM sos_incidents WHERE id = $1',
      [incident_id],
    );
    expect(dbRes.rows[0]!.location_captured_at).toEqual(new Date(capturedAt));
  });

  it('location_captured_at 省略時は null（既存互換）', async () => {
    const { token: wToken } = await createWatcher();
    const { clientId, deviceToken } = await createClient(wToken);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sos',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { lat: 35.68, lng: 139.77 },
    });

    expect(res.statusCode).toBe(201);
    const { incident_id } = JSON.parse(res.body);

    const dbRes = await query<{ location_captured_at: Date | null }>(
      'SELECT location_captured_at FROM sos_incidents WHERE id = $1',
      [incident_id],
    );
    expect(dbRes.rows[0]!.location_captured_at).toBeNull();
  });

  it('GET /v1/sos/:id に location_captured_at が含まれる', async () => {
    const { token: wToken, watcherId } = await createWatcher();
    const { clientId, deviceToken } = await createClient(wToken);
    const capturedAt = '2026-07-17T23:00:00.000Z';

    const sosRes = await app.inject({
      method: 'POST',
      url: '/v1/sos',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { lat: 35.68, lng: 139.77, location_captured_at: capturedAt },
    });
    const { incident_id } = JSON.parse(sosRes.body);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/sos/${incident_id}`,
      headers: { authorization: `Bearer ${wToken}` },
    });

    expect(detailRes.statusCode).toBe(200);
    const detail = JSON.parse(detailRes.body);
    expect(detail.location_captured_at).toBe(new Date(capturedAt).toISOString());
  });

  it('location_captured_at なしの SOS 詳細では null が返る', async () => {
    const { token: wToken } = await createWatcher();
    const { clientId, deviceToken } = await createClient(wToken);

    const sosRes = await app.inject({
      method: 'POST',
      url: '/v1/sos',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { lat: 35.68, lng: 139.77 },
    });
    const { incident_id } = JSON.parse(sosRes.body);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/sos/${incident_id}`,
      headers: { authorization: `Bearer ${wToken}` },
    });

    expect(detailRes.statusCode).toBe(200);
    expect(JSON.parse(detailRes.body).location_captured_at).toBeNull();
  });
});
