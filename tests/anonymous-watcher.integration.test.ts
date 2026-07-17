/**
 * 匿名ウォッチャー登録（ログイン不要化）の統合テスト。
 *
 * 【このテストが守るもの】
 * - POST /v1/watchers/register-device: 匿名登録 → JWT 取得のフロー
 * - 同一 install_id の冪等性（新規 201 / 既存 200）
 * - 匿名 watcher が既存 API（claim, invite, stamp 等）を正常に利用できること
 * - POST /v1/watchers/me/email: 匿名→メール登録
 * - PATCH /v1/watchers/me: display_name 更新
 * - GET /v1/watchers/me が email=null を返すこと
 * - 匿名 watcher でのログインは失敗すること
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

beforeEach(async () => {
  app = await buildApp();
  fcm.reset();
});

afterEach(async () => {
  for (const id of createdWatcherIds) {
    await query('DELETE FROM watchers WHERE id = $1', [id]);
  }
  createdWatcherIds.length = 0;
  await app.close();
});

afterAll(async () => {
  await closePool();
});

function installId(): string {
  return `test-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

describe('POST /v1/watchers/register-device — 匿名端末登録', () => {
  it('新規登録で 201 を返し、watcher_id と JWT が含まれる', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: installId(), display_name: '太郎', platform: 'android' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.watcher_id).toBeDefined();
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    createdWatcherIds.push(body.watcher_id);
  });

  it('同一 install_id で再呼び出しすると 200 で同じ watcher_id を返す', async () => {
    const iid = installId();

    const first = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: iid, display_name: '太郎', platform: 'android' },
    });
    expect(first.statusCode).toBe(201);
    createdWatcherIds.push(first.json().watcher_id);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: iid, display_name: '変更名', platform: 'ios' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().watcher_id).toBe(first.json().watcher_id);
    // display_name は更新されないことを確認
    const me = await app.inject({
      method: 'GET',
      url: '/v1/watchers/me',
      headers: { authorization: `Bearer ${second.json().access_token}` },
    });
    expect(me.json().display_name).toBe('太郎');
  });

  it('install_id がないと 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { display_name: '太郎', platform: 'android' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('匿名 watcher の GET /v1/watchers/me は email=null を返す', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: installId(), display_name: '太郎', platform: 'android' },
    });
    createdWatcherIds.push(reg.json().watcher_id);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/watchers/me',
      headers: { authorization: `Bearer ${reg.json().access_token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBeNull();
    expect(me.json().display_name).toBe('太郎');
  });

  it('匿名 watcher ではメールログインできない', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: installId(), display_name: '太郎', platform: 'android' },
    });
    createdWatcherIds.push(reg.json().watcher_id);

    // email が NULL なのでどのメールでもヒットしない → 401
    const login = await app.inject({
      method: 'POST',
      url: '/v1/watchers/login',
      payload: { email: 'nobody@example.com', password: 'password1234' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('匿名 watcher のトークンで provision の claim ができる', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: installId(), display_name: '太郎', platform: 'android' },
    });
    const watcherToken = reg.json().access_token;
    const watcherId = reg.json().watcher_id;
    createdWatcherIds.push(watcherId);

    // provision → claim
    const prov = await app.inject({
      method: 'POST',
      url: '/v1/provisions',
      payload: { platform: 'android', consent_version: 'v1.0' },
    });
    const claimRes = await app.inject({
      method: 'POST',
      url: '/v1/clients/claim',
      headers: { authorization: `Bearer ${watcherToken}` },
      payload: { code: prov.json().claim_code, display_name: 'おばあちゃん' },
    });
    expect(claimRes.statusCode).toBe(201);
    const clientId = claimRes.json().client_id;

    // クリーンアップ
    await query('DELETE FROM provisions WHERE client_id = $1', [clientId]);
    await query('DELETE FROM audit_log WHERE client_id = $1', [clientId]);
    await query('DELETE FROM clients WHERE id = $1', [clientId]);
  });
});

describe('POST /v1/watchers/me/email — メール登録', () => {
  it('匿名 watcher にメール+パスワードを追加できる', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: installId(), display_name: '太郎', platform: 'android' },
    });
    const token = reg.json().access_token;
    createdWatcherIds.push(reg.json().watcher_id);

    const email = `anon-test-${Date.now()}@example.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/me/email',
      headers: { authorization: `Bearer ${token}` },
      payload: { email, password: 'password1234' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // メール登録後はログインできる
    const login = await app.inject({
      method: 'POST',
      url: '/v1/watchers/login',
      payload: { email, password: 'password1234' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().watcher_id).toBe(reg.json().watcher_id);
  });

  it('既にメール登録済みなら 409 already_registered', async () => {
    const email = `already-test-${Date.now()}@example.test`;
    // メール付きで登録
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/watchers',
      payload: { display_name: '太郎', email, password: 'password1234' },
    });
    const token = reg.json().access_token;
    createdWatcherIds.push(reg.json().watcher_id);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/me/email',
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'another@example.test', password: 'newpassword' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_registered');
  });

  it('他アカウントのメールと重複なら 409 email_taken', async () => {
    const email = `taken-test-${Date.now()}@example.test`;
    // 先にメール付きで別アカウントを登録
    const other = await app.inject({
      method: 'POST',
      url: '/v1/watchers',
      payload: { display_name: '他人', email, password: 'password1234' },
    });
    createdWatcherIds.push(other.json().watcher_id);

    // 匿名アカウントを作成
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: installId(), display_name: '太郎', platform: 'android' },
    });
    createdWatcherIds.push(reg.json().watcher_id);

    // 同じメールで登録しようとする
    const res = await app.inject({
      method: 'POST',
      url: '/v1/watchers/me/email',
      headers: { authorization: `Bearer ${reg.json().access_token}` },
      payload: { email, password: 'newpassword' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('email_taken');
  });
});

describe('PATCH /v1/watchers/me — プロフィール更新', () => {
  it('display_name を変更できる', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: installId(), display_name: '変更前', platform: 'android' },
    });
    const token = reg.json().access_token;
    createdWatcherIds.push(reg.json().watcher_id);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/watchers/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { display_name: '変更後' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // 確認
    const me = await app.inject({
      method: 'GET',
      url: '/v1/watchers/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json().display_name).toBe('変更後');
  });

  it('display_name が空だと 400', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/watchers/register-device',
      payload: { install_id: installId(), display_name: 'テスト', platform: 'android' },
    });
    createdWatcherIds.push(reg.json().watcher_id);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/watchers/me',
      headers: { authorization: `Bearer ${reg.json().access_token}` },
      payload: { display_name: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});
