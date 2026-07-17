/**
 * 追加ウォッチャー招待 API（多対多ペアリング）。
 *
 * 【設計思想】
 * 既にペアリング済みのクライアント端末が「追加ウォッチャー用のコード」を発行し、
 * 2人目・3人目のウォッチャーが watch_link のみを作成して紐づく。
 * 新規 client / device は作らない。
 *
 * provision（初回オンボーディング用）とは責務を分離する。
 * provision は認証なし + client/device 作成、invite は device 認証 + watch_link のみ作成。
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { checkClientQuota, createWatchLink } from '../lib/plan.js';

/** 招待コードの TTL（分） */
const INVITE_TTL_MINUTES = 30;

/** join リクエストスキーマ */
const joinSchema = z.object({
  /** invite_code（QR）または fallback_code（6桁手入力）。 */
  code: z.string().min(1).max(200),
  /** ウォッチャーが認識しているクライアントの表示名。join 自体にのみ使用（client を更新しない）。 */
  display_name: z.string().min(1).max(100),
});

/** QR 用の長いランダム文字列（provision と同じ形式）。 */
function generateInviteCode(): string {
  return randomBytes(32).toString('base64url');
}

/** 手入力フォールバック用6桁コード。 */
function generateFallbackCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** UUID 形式チェック */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 招待コード関連ルートを登録する。
 */
export default async function inviteRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/invite-codes 🔒device — 追加ウォッチャー招待コード発行
   *
   * client_id はデバイストークンから取得。新規 client/device は作らない。
   * TTL 30分。
   *
   * 201: コード発行成功
   * 429: レート制限
   */
  app.post(
    '/v1/invite-codes',
    {
      preHandler: app.requireDevice,
      config: {
        rateLimit: { max: 10, timeWindow: '1 hour' },
      },
    },
    async (req, reply) => {
      const clientId = req.clientId!;

      const inviteCode = generateInviteCode();

      // fallback_code の衝突チェック（有効期限内・未 join の同一コードがなければOK）
      let fallbackCode: string | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateFallbackCode();
        const existing = await query(
          `SELECT 1 FROM invite_codes
           WHERE fallback_code = $1 AND expires_at > now() AND joined_at IS NULL
           LIMIT 1`,
          [candidate],
        );
        if (existing.rows.length === 0) {
          fallbackCode = candidate;
          break;
        }
      }

      if (!fallbackCode) {
        return reply.code(503).send({
          error: 'code_generation_failed',
          message: 'しばらくしてからお試しください',
        });
      }

      const res = await query<{ id: string }>(
        `INSERT INTO invite_codes (client_id, invite_code, fallback_code, expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
         RETURNING id`,
        [clientId, inviteCode, fallbackCode, INVITE_TTL_MINUTES],
      );

      return reply.code(201).send({
        invite_id: res.rows[0]!.id,
        invite_code: inviteCode,
        fallback_code: fallbackCode,
        expires_in_minutes: INVITE_TTL_MINUTES,
      });
    },
  );

  /**
   * GET /v1/invite-codes/:invite_id 🔒device — 招待の join 状態ポーリング
   *
   * クライアント端末がポーリングして「登録されました」を表示するため。
   * 自分の client_id に紐づく invite のみ参照可能。
   *
   * 200: { joined: boolean, watcher_name?: string }
   * 404: 存在しない or 他の client の invite
   */
  app.get(
    '/v1/invite-codes/:invite_id',
    { preHandler: app.requireDevice },
    async (req, reply) => {
      const { invite_id: inviteId } = req.params as { invite_id: string };
      if (!UUID_RE.test(inviteId)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'invite_id が不正です' });
      }

      const clientId = req.clientId!;

      const res = await query<{
        joined_at: Date | null;
        joined_by: string | null;
        watcher_name: string | null;
      }>(
        `SELECT ic.joined_at, ic.joined_by, w.display_name AS watcher_name
         FROM invite_codes ic
         LEFT JOIN watchers w ON w.id = ic.joined_by
         WHERE ic.id = $1 AND ic.client_id = $2`,
        [inviteId, clientId],
      );

      const row = res.rows[0];
      if (!row) {
        return reply.code(404).send({ error: 'not_found' });
      }

      if (!row.joined_at) {
        return reply.send({ joined: false });
      }

      return reply.send({
        joined: true,
        watcher_name: row.watcher_name ?? undefined,
      });
    },
  );

  /**
   * POST /v1/clients/join 🔒watcher — ウォッチャーが招待を受けてwatch_link作成
   *
   * invite_code（QR）または fallback_code（手入力）で既存クライアントに紐づく。
   * client / device は作らない（watch_link のみ）。
   *
   * 201: join 成功
   * 400: バリデーションエラー
   * 402: 無料枠超過
   * 404: コード不正/期限切れ
   * 409: already_joined（同一 watcher が既に紐づき済み）or already_used（コード消費済み）
   */
  app.post(
    '/v1/clients/join',
    { preHandler: app.requireWatcher },
    async (req, reply) => {
      const parsed = joinSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { code, display_name } = parsed.data;
      const watcherId = req.watcherId!;

      // 無料枠チェック
      const quota = await checkClientQuota(watcherId);
      if (quota.exceedsFreeTier) {
        return reply.code(402).send({
          error: 'payment_required',
          message: '3人目以降の見守りには課金が必要です',
          current_count: quota.currentCount,
          free_limit: 2,
        });
      }

      const result = await withTransaction(async (tx) => {
        // invite_code または fallback_code で検索（期限内・未 join）
        const invRes = await tx.query<{
          id: string;
          client_id: string;
          joined_at: Date | null;
        }>(
          `SELECT id, client_id, joined_at
           FROM invite_codes
           WHERE (invite_code = $1 OR fallback_code = $1)
             AND expires_at > now()
           FOR UPDATE`,
          [code],
        );

        const inv = invRes.rows[0];
        if (!inv) return { error: 'not_found' as const };
        if (inv.joined_at) return { error: 'already_used' as const };

        // 既に同じ watcher が紐づき済みかチェック
        const existingLink = await tx.query(
          'SELECT 1 FROM watch_links WHERE watcher_id = $1 AND client_id = $2',
          [watcherId, inv.client_id],
        );
        if (existingLink.rows.length > 0) {
          return { error: 'already_joined' as const };
        }

        // watch_link のみ作成
        const billable = await createWatchLink(tx, watcherId, inv.client_id);

        // invite を消費済みにする
        await tx.query(
          'UPDATE invite_codes SET joined_at = now(), joined_by = $1 WHERE id = $2',
          [watcherId, inv.id],
        );

        // 監査ログ
        await audit(
          inv.client_id,
          'watcher_joined',
          {
            watcher_id: watcherId,
            invite_id: inv.id,
            display_name,
            billable,
          },
          tx,
        );

        return { clientId: inv.client_id };
      });

      if ('error' in result) {
        if (result.error === 'not_found') {
          return reply.code(404).send({
            error: 'not_found',
            message: 'コードが無効か、有効期限が切れています',
          });
        }
        if (result.error === 'already_used') {
          return reply.code(409).send({
            error: 'already_used',
            message: 'このコードは既に使用されています',
          });
        }
        // already_joined
        return reply.code(409).send({
          error: 'already_joined',
          message: 'このクライアントには既に見守り登録済みです',
        });
      }

      return reply.code(201).send({ client_id: result.clientId });
    },
  );

  /**
   * GET /v1/clients/me/watchers 🔒device — 紐づきウォッチャー一覧
   *
   * ホーム画面の「見守り人一覧」表示用。名前のみ返す（最小開示）。
   */
  app.get(
    '/v1/clients/me/watchers',
    { preHandler: app.requireDevice },
    async (req, reply) => {
      const clientId = req.clientId!;

      const res = await query<{ display_name: string }>(
        `SELECT w.display_name
         FROM watchers w
         JOIN watch_links l ON l.watcher_id = w.id
         WHERE l.client_id = $1
         ORDER BY l.created_at`,
        [clientId],
      );

      return reply.send(res.rows.map((r) => ({ display_name: r.display_name })));
    },
  );
}
