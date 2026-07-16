/**
 * ウォッチャー（見守る側）の登録・認証・設定API。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueWatcherTokens, type TokenPayload } from '../auth/jwt.js';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

/** 登録リクエスト */
const registerSchema = z.object({
  display_name: z.string().min(1).max(100),
  email: z.string().email().max(255),
  // 見守りサービスの認証情報が破られると、他人の安否状態が漏れる。
  // 最低8文字を強制する（NIST SP 800-63B の最小要件）。
  password: z.string().min(8).max(200),
});

/** ログインリクエスト */
const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

/** FCMトークン登録 */
const fcmTokenSchema = z.object({
  fcm_token: z.string().min(1).max(500),
});

/** 通知設定 */
const settingsSchema = z.object({
  notify_watch: z.boolean().optional(),
  // SMSフォールバック用。ownerプランでのみ使われる。
  phone_number: z.string().max(20).regex(/^\+?[0-9]+$/, 'E.164形式で入力してください').nullish(),
});

/** リフレッシュリクエスト */
const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

/**
 * ウォッチャー関連ルートを登録する。
 *
 * @param app - fastify インスタンス
 */
export default async function watcherRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/watchers — ウォッチャー登録
   *
   * Phase 1 はメール+パスワード。Sign in with Google は Phase 2。
   */
  app.post('/v1/watchers', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { display_name, email, password } = parsed.data;

    // メールは大文字小文字を区別せず一意にする
    const normalizedEmail = email.toLowerCase().trim();
    const password_hash = await hashPassword(password);

    try {
      const res = await query<{ id: string }>(
        `INSERT INTO watchers (display_name, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id`,
        [display_name, normalizedEmail, password_hash],
      );
      const watcherId = res.rows[0]!.id;
      const tokens = issueWatcherTokens(app, watcherId);
      return reply.code(201).send({ watcher_id: watcherId, ...tokens });
    } catch (err) {
      // 23505 = unique_violation（メール重複）
      if ((err as { code?: string }).code === '23505') {
        return reply
          .code(409)
          .send({ error: 'email_taken', message: 'このメールアドレスは登録済みです' });
      }
      throw err;
    }
  });

  /**
   * POST /v1/watchers/login — ログイン
   */
  app.post('/v1/watchers/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const { email, password } = parsed.data;

    const res = await query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM watchers WHERE email = $1',
      [email.toLowerCase().trim()],
    );

    const watcher = res.rows[0];

    // 【重要】ユーザーの存在有無を応答から推測できないようにする。
    // 存在しない場合も検証を実行して応答時間を揃える（ユーザー列挙攻撃対策）。
    const DUMMY_HASH =
      'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const ok = await verifyPassword(password, watcher?.password_hash ?? DUMMY_HASH);

    if (!watcher || !ok) {
      return reply
        .code(401)
        .send({ error: 'invalid_credentials', message: 'メールアドレスまたはパスワードが違います' });
    }

    const tokens = issueWatcherTokens(app, watcher.id);
    return reply.send({ watcher_id: watcher.id, ...tokens });
  });

  /**
   * POST /v1/watchers/refresh — アクセストークンの再発行
   */
  app.post('/v1/watchers/refresh', async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    try {
      const payload = app.jwt.verify<TokenPayload>(parsed.data.refresh_token);
      // refresh トークン以外（access）でのリフレッシュを拒否する
      if (payload.role !== 'watcher' || payload.typ !== 'refresh') {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      // 退会済みウォッチャーのトークンを弾く
      const exists = await query('SELECT 1 FROM watchers WHERE id = $1', [payload.sub]);
      if (exists.rowCount === 0) {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      return reply.send(issueWatcherTokens(app, payload.sub));
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }
  });

  /**
   * GET /v1/watchers/me — 自分の情報
   */
  app.get('/v1/watchers/me', { preHandler: app.requireWatcher }, async (req, reply) => {
    const res = await query(
      `SELECT id, display_name, email, plan, notify_watch, phone_number, created_at
         FROM watchers WHERE id = $1`,
      [req.watcherId],
    );
    const me = res.rows[0];
    if (!me) return reply.code(404).send({ error: 'not_found' });

    // 課金判定に使う: 現在の見守り対象数と、うち課金対象数
    const counts = await query<{ total: number; billable: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE billable)::int AS billable
         FROM watch_links WHERE watcher_id = $1`,
      [req.watcherId],
    );

    return reply.send({ ...me, ...counts.rows[0] });
  });

  /**
   * PUT /v1/watchers/me/fcm-token — FCMトークンの登録・更新
   */
  app.put('/v1/watchers/me/fcm-token', { preHandler: app.requireWatcher }, async (req, reply) => {
    const parsed = fcmTokenSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    await query('UPDATE watchers SET fcm_token = $2 WHERE id = $1', [
      req.watcherId,
      parsed.data.fcm_token,
    ]);
    return reply.send({ ok: true });
  });

  /**
   * PUT /v1/watchers/me/settings — 通知設定の更新
   */
  app.put('/v1/watchers/me/settings', { preHandler: app.requireWatcher }, async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { notify_watch, phone_number } = parsed.data;

    // COALESCE で「未指定なら変更しない」を実現する。
    // phone_number は明示的な null で削除したいので undefined と null を区別する。
    await query(
      `UPDATE watchers
          SET notify_watch = COALESCE($2, notify_watch),
              phone_number = CASE WHEN $3::boolean THEN $4 ELSE phone_number END
        WHERE id = $1`,
      [
        req.watcherId,
        notify_watch ?? null,
        phone_number !== undefined,
        phone_number ?? null,
      ],
    );
    return reply.send({ ok: true });
  });
}
