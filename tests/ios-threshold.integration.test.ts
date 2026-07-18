/**
 * iOS 端末向け初期しきい値の統合テスト。
 *
 * 【このテストが守るもの】
 * - iOS クライアント作成時に初期 threshold が 24h (1440分) になること
 * - Android クライアントは従来どおり 15h (900分)
 * - usage_frequency='frequent' は platform に関わらず 10h (600分)
 * - 既存クライアントの threshold が機種変更ログインで上書きされないこと
 * - getInitialThreshold ヘルパーの単体テスト
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { setFcmDriver, type FcmDriver, type PushRequest } from '../src/notify/fcm.js';
import { getInitialThreshold } from '../src/lib/plan.js';

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
  const email = `test-ios-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/watchers',
    payload: { display_name: 'テストW', email, password: 'password1234' },
  });
  const body = JSON.parse(res.body);
  createdWatcherIds.push(body.watcher_id);
  return { watcherId: body.watcher_id, token: body.access_token };
}

async function createClientViaPair(
  watcherToken: string,
  platform: string,
  usageFrequency?: string,
): Promise<string> {
  const codeRes = await app.inject({
    method: 'POST',
    url: '/v1/pairing-codes',
    headers: { authorization: `Bearer ${watcherToken}` },
  });
  const { code } = JSON.parse(codeRes.body);

  const pairRes = await app.inject({
    method: 'POST',
    url: '/v1/clients/pair',
    payload: {
      code,
      display_name: 'テスト',
      consent_version: '1.0',
      platform,
      ...(usageFrequency ? { usage_frequency: usageFrequency } : {}),
    },
  });
  const body = JSON.parse(pairRes.body);
  createdClientIds.push(body.client_id);
  return body.client_id;
}

// =============================================================================
// getInitialThreshold ヘルパーの単体テスト
// =============================================================================
describe('getInitialThreshold', () => {
  it('Android (デフォルト) → 900分 (15時間)', () => {
    expect(getInitialThreshold('android')).toBe(900);
  });

  it('iOS → 1440分 (24時間)', () => {
    expect(getInitialThreshold('ios')).toBe(1440);
  });

  it('iOS (大文字混在) → 1440分', () => {
    expect(getInitialThreshold('iOS')).toBe(1440);
  });

  it('frequent 申告は platform に関わらず 600分 (10時間)', () => {
    expect(getInitialThreshold('android', 'frequent')).toBe(600);
    expect(getInitialThreshold('ios', 'frequent')).toBe(600);
  });

  it('occasional 申告 + Android → 900分', () => {
    expect(getInitialThreshold('android', 'occasional')).toBe(900);
  });

  it('occasional 申告 + iOS → 1440分', () => {
    expect(getInitialThreshold('ios', 'occasional')).toBe(1440);
  });

  it('未知の platform → Android と同じデフォルト', () => {
    expect(getInitialThreshold('unknown')).toBe(900);
  });
});

// =============================================================================
// clients/pair 経由 — platform による初期閾値
// =============================================================================
describe('POST /v1/clients/pair — iOS threshold', () => {
  it('iOS クライアントの初期 threshold は 1440分（24時間）', async () => {
    const { token } = await createWatcher();
    const clientId = await createClientViaPair(token, 'ios');

    const res = await query<{ threshold_minutes: number }>(
      'SELECT threshold_minutes FROM clients WHERE id = $1',
      [clientId],
    );
    expect(res.rows[0]!.threshold_minutes).toBe(1440);
  });

  it('Android クライアントの初期 threshold は 900分（15時間・従来どおり）', async () => {
    const { token } = await createWatcher();
    const clientId = await createClientViaPair(token, 'android');

    const res = await query<{ threshold_minutes: number }>(
      'SELECT threshold_minutes FROM clients WHERE id = $1',
      [clientId],
    );
    expect(res.rows[0]!.threshold_minutes).toBe(900);
  });

  it('iOS + frequent 申告 → 600分（frequent が優先）', async () => {
    const { token } = await createWatcher();
    const clientId = await createClientViaPair(token, 'ios', 'frequent');

    const res = await query<{ threshold_minutes: number }>(
      'SELECT threshold_minutes FROM clients WHERE id = $1',
      [clientId],
    );
    expect(res.rows[0]!.threshold_minutes).toBe(600);
  });
});

// =============================================================================
// provision/claim 経由 — iOS threshold
// =============================================================================
describe('POST /v1/clients/claim — iOS threshold', () => {
  it('iOS provision の claim で初期 threshold が 1440分になる', async () => {
    // provision 作成（iOS）
    const provRes = await app.inject({
      method: 'POST',
      url: '/v1/provisions',
      payload: { platform: 'ios', consent_version: '1.0' },
    });
    expect(provRes.statusCode).toBe(201);
    const { claim_code, claim_secret } = JSON.parse(provRes.body);

    // watcher が claim
    const { token: wToken } = await createWatcher();
    const claimRes = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${wToken}` },
      payload: { code: claim_code, display_name: 'iOS高齢者' },
    });
    expect(claimRes.statusCode).toBe(201);
    const { client_id } = JSON.parse(claimRes.body);
    createdClientIds.push(client_id);

    // cleanup provision
    await query('DELETE FROM provisions WHERE claim_code = $1', [claim_code]);

    const res = await query<{ threshold_minutes: number }>(
      'SELECT threshold_minutes FROM clients WHERE id = $1',
      [client_id],
    );
    expect(res.rows[0]!.threshold_minutes).toBe(1440);
  });

  it('Android provision の claim は 900分（従来どおり）', async () => {
    const provRes = await app.inject({
      method: 'POST',
      url: '/v1/provisions',
      payload: { platform: 'android', consent_version: '1.0' },
    });
    const { claim_code } = JSON.parse(provRes.body);

    const { token: wToken } = await createWatcher();
    const claimRes = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${wToken}` },
      payload: { code: claim_code, display_name: 'Android高齢者' },
    });
    const { client_id } = JSON.parse(claimRes.body);
    createdClientIds.push(client_id);
    await query('DELETE FROM provisions WHERE claim_code = $1', [claim_code]);

    const res = await query<{ threshold_minutes: number }>(
      'SELECT threshold_minutes FROM clients WHERE id = $1',
      [client_id],
    );
    expect(res.rows[0]!.threshold_minutes).toBe(900);
  });
});

// =============================================================================
// clients/login — 既存 threshold を上書きしない
// =============================================================================
describe('POST /v1/clients/login — threshold 不変', () => {
  it('機種変更ログインで既存クライアントの threshold は変わらない', async () => {
    const { token: wToken } = await createWatcher();
    const clientId = await createClientViaPair(wToken, 'android');

    // 学習済みをシミュレート: threshold を 720 に変更
    await query(
      "UPDATE clients SET threshold_minutes = 720, threshold_mode = 'learned' WHERE id = $1",
      [clientId],
    );

    // メール登録
    const email = `ios-login-${Date.now()}@example.com`;
    const deviceToken = JSON.parse(
      (await app.inject({
        method: 'POST',
        url: '/v1/pairing-codes',
        headers: { authorization: `Bearer ${wToken}` },
      })).body,
    ).code;

    // 直接 DB でメール設定（テスト簡略化）
    const { hashPassword } = await import('../src/lib/password.js');
    const hash = await hashPassword('securepass123');
    await query('UPDATE clients SET email = $1, password_hash = $2 WHERE id = $3', [
      email,
      hash,
      clientId,
    ]);

    // iOS 端末でログイン
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
    expect(loginRes.statusCode).toBe(200);

    // threshold は 720 のまま（上書きされていない）
    const res = await query<{ threshold_minutes: number; threshold_mode: string }>(
      'SELECT threshold_minutes, threshold_mode FROM clients WHERE id = $1',
      [clientId],
    );
    expect(res.rows[0]!.threshold_minutes).toBe(720);
    expect(res.rows[0]!.threshold_mode).toBe('learned');
  });
});
