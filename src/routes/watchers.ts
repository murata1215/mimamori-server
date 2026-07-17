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

/** 匿名端末登録リクエスト */
const registerDeviceSchema = z.object({
  install_id: z.string().min(1).max(200),
  display_name: z.string().min(1).max(100),
  platform: z.string().min(1).max(50),
});

/** メール登録（匿名→メール）リクエスト */
const addEmailSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
});

/** プロフィール更新リクエスト */
const patchProfileSchema = z.object({
  display_name: z.string().min(1).max(100),
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

  /**
   * POST /v1/watchers/register-device — 匿名端末登録（認証不要）
   *
   * メール+パスワードなしでウォッチャーアカウントを作成する。
   * install_id（アプリ生成UUID）で端末を識別し、同一 install_id なら既存 watcher の
   * トークンを再発行する（冪等）。
   *
   * 新規: 201、既存 install_id: 200
   */
  app.post(
    '/v1/watchers/register-device',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 hour',
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (req, reply) => {
      const parsed = registerDeviceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { install_id, display_name, platform } = parsed.data;

      // 同一 install_id の既存ウォッチャーを検索
      const existing = await query<{ id: string }>(
        'SELECT id FROM watchers WHERE install_id = $1',
        [install_id],
      );

      if (existing.rows.length > 0) {
        // 既存: トークンのみ再発行（display_name / platform は更新しない）
        const watcherId = existing.rows[0]!.id;
        const tokens = issueWatcherTokens(app, watcherId);
        return reply.code(200).send({ watcher_id: watcherId, ...tokens });
      }

      // 新規: email / password_hash は NULL のまま作成
      const res = await query<{ id: string }>(
        `INSERT INTO watchers (display_name, install_id)
         VALUES ($1, $2) RETURNING id`,
        [display_name, install_id],
      );
      const watcherId = res.rows[0]!.id;
      const tokens = issueWatcherTokens(app, watcherId);
      return reply.code(201).send({ watcher_id: watcherId, ...tokens });
    },
  );

  /**
   * POST /v1/watchers/me/email — 匿名→メール登録
   *
   * 匿名ウォッチャーにメール+パスワードを付与する。
   * 機種変更時の復元、複数端末ログイン、有料プラン購入の領収書送付等の用途。
   * 既にメール登録済みなら 409 already_registered。
   */
  app.post(
    '/v1/watchers/me/email',
    { preHandler: app.requireWatcher },
    async (req, reply) => {
      const parsed = addEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { email, password } = parsed.data;
      const watcherId = req.watcherId!;

      // 既にメール登録済みかチェック
      const me = await query<{ email: string | null }>(
        'SELECT email FROM watchers WHERE id = $1',
        [watcherId],
      );
      if (me.rows[0]?.email) {
        return reply.code(409).send({
          error: 'already_registered',
          message: '既にメールアドレスが登録されています',
        });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const password_hash = await hashPassword(password);

      try {
        await query(
          'UPDATE watchers SET email = $2, password_hash = $3 WHERE id = $1',
          [watcherId, normalizedEmail, password_hash],
        );
        return reply.send({ ok: true });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.code(409).send({
            error: 'email_taken',
            message: 'このメールアドレスは他のアカウントで使用されています',
          });
        }
        throw err;
      }
    },
  );

  /**
   * PATCH /v1/watchers/me — プロフィール更新
   *
   * display_name の変更用。既存の PUT /v1/watchers/me/settings とは分離する。
   */
  app.patch(
    '/v1/watchers/me',
    { preHandler: app.requireWatcher },
    async (req, reply) => {
      const parsed = patchProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { display_name } = parsed.data;

      await query('UPDATE watchers SET display_name = $2 WHERE id = $1', [
        req.watcherId,
        display_name,
      ]);
      return reply.send({ ok: true });
    },
  );
}
