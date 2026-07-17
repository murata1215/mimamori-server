/**
 * スタンプ API（双方向の軽量コミュニケーション）。
 *
 * クライアント（見守られる側）とウォッチャー（見守る側）で
 * スタンプを双方向にやり取りする。テキストメッセージはなし。
 *
 * - stamp は text（enum にしない）。初期セット: 'fine', 'not_well', 'bad'。
 *   種類の追加にスキーマ変更不要。
 * - sender_name は送信時点の display_name をスナップショット保存。
 * - 既読管理はサーバー側では行わない（Flutter 側で last_seen_at をローカル管理）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { notifyStampToClient, notifyStampToWatchers } from '../notify/dispatcher.js';

/** スタンプ送信スキーマ */
const stampSchema = z.object({
  stamp: z.string().min(1).max(50),
});

/** GET のクエリパラメータ */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before_id: z.coerce.number().int().positive().optional(),
});

/** DB から取得するスタンプ行 */
interface StampRow {
  id: number;
  stamp: string;
  direction: 'from_client' | 'from_watcher';
  sender_name: string;
  created_at: Date;
}

/** レスポンス用のスタンプ要素 */
function formatStamp(row: StampRow) {
  return {
    id: String(row.id),
    stamp: row.stamp,
    direction: row.direction,
    sender_name: row.sender_name,
    created_at: row.created_at.toISOString(),
  };
}

/** client_id の UUID 形式チェック */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * スタンプのルートを登録する。
 */
export default async function stampRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/stamps 🔒device — クライアントがスタンプ送信
   *
   * 全紐づきウォッチャーへ FCM push。
   * レート制限: 30回/時（per client_id）。
   */
  app.post(
    '/v1/stamps',
    {
      preHandler: app.requireDevice,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 hour',
        },
      },
    },
    async (req, reply) => {
      const parsed = stampSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { stamp } = parsed.data;
      const clientId = req.clientId!;

      // クライアントの display_name をスナップショット保存
      const nameRes = await query<{ display_name: string }>(
        'SELECT display_name FROM clients WHERE id = $1',
        [clientId],
      );
      const clientName = nameRes.rows[0]?.display_name ?? '不明';

      const res = await query<{ id: number }>(
        `INSERT INTO stamps (client_id, direction, sender_id, sender_name, stamp)
         VALUES ($1, 'from_client', $1, $2, $3)
         RETURNING id`,
        [clientId, clientName, stamp],
      );

      const stampId = String(res.rows[0]!.id);

      // FCM push（非同期。送信失敗でもスタンプ自体は保存済み）
      void notifyStampToWatchers(clientId, stamp, clientName).catch((err) => {
        console.error('[stamps] ウォッチャーへの通知に失敗:', err);
      });

      return reply.code(201).send({ stamp_id: stampId });
    },
  );

  /**
   * POST /v1/clients/:client_id/stamps 🔒watcher — ウォッチャーがスタンプ送信
   *
   * watch_link がないと 404（存在有無を漏らさない既存ルール）。
   */
  app.post(
    '/v1/clients/:client_id/stamps',
    { preHandler: app.requireWatcher },
    async (req, reply) => {
      const { client_id: clientId } = req.params as { client_id: string };
      if (!UUID_RE.test(clientId)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'client_id が不正です' });
      }

      const parsed = stampSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { stamp } = parsed.data;
      const watcherId = req.watcherId!;

      // watch_link の確認（権限なし = 404）
      const linkRes = await query(
        'SELECT 1 FROM watch_links WHERE watcher_id = $1 AND client_id = $2',
        [watcherId, clientId],
      );
      if (linkRes.rows.length === 0) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // ウォッチャーの display_name
      const nameRes = await query<{ display_name: string }>(
        'SELECT display_name FROM watchers WHERE id = $1',
        [watcherId],
      );
      const senderName = nameRes.rows[0]?.display_name ?? '不明';

      const res = await query<{ id: number }>(
        `INSERT INTO stamps (client_id, direction, sender_id, sender_name, stamp)
         VALUES ($1, 'from_watcher', $2, $3, $4)
         RETURNING id`,
        [clientId, watcherId, senderName, stamp],
      );

      const stampId = String(res.rows[0]!.id);

      // FCM push（非同期）
      void notifyStampToClient(clientId, stamp, senderName).catch((err) => {
        console.error('[stamps] クライアントへの通知に失敗:', err);
      });

      return reply.code(201).send({ stamp_id: stampId });
    },
  );

  /**
   * GET /v1/stamps/me 🔒device — クライアントの送受信履歴
   *
   * 新しい順。cursor ページネーション（before_id）。
   */
  app.get(
    '/v1/stamps/me',
    { preHandler: app.requireDevice },
    async (req, reply) => {
      const clientId = req.clientId!;
      const qParsed = listQuerySchema.safeParse(req.query);
      if (!qParsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: qParsed.error.issues });
      }
      const { limit, before_id } = qParsed.data;

      let sql = `SELECT id, stamp, direction, sender_name, created_at
                 FROM stamps WHERE client_id = $1`;
      const params: unknown[] = [clientId];

      if (before_id !== undefined) {
        sql += ` AND id < $${params.length + 1}`;
        params.push(before_id);
      }

      sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const res = await query<StampRow>(sql, params);
      return reply.send(res.rows.map(formatStamp));
    },
  );

  /**
   * GET /v1/clients/:client_id/stamps 🔒watcher — ウォッチャーの閲覧
   *
   * watch_link がないと 404。双方向の履歴を返す。
   */
  app.get(
    '/v1/clients/:client_id/stamps',
    { preHandler: app.requireWatcher },
    async (req, reply) => {
      const { client_id: clientId } = req.params as { client_id: string };
      if (!UUID_RE.test(clientId)) {
        return reply.code(400).send({ error: 'invalid_request', message: 'client_id が不正です' });
      }

      const watcherId = req.watcherId!;
      const linkRes = await query(
        'SELECT 1 FROM watch_links WHERE watcher_id = $1 AND client_id = $2',
        [watcherId, clientId],
      );
      if (linkRes.rows.length === 0) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const qParsed = listQuerySchema.safeParse(req.query);
      if (!qParsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: qParsed.error.issues });
      }
      const { limit, before_id } = qParsed.data;

      let sql = `SELECT id, stamp, direction, sender_name, created_at
                 FROM stamps WHERE client_id = $1`;
      const params: unknown[] = [clientId];

      if (before_id !== undefined) {
        sql += ` AND id < $${params.length + 1}`;
        params.push(before_id);
      }

      sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const res = await query<StampRow>(sql, params);
      return reply.send(res.rows.map(formatStamp));
    },
  );
}
