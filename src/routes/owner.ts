/**
 * オーナープラン（有料）向けAPI。
 *
 * 【課金設計の原則】(spec 5)
 * 限界費用が発生する機能・事業者向けの利便性機能は有料側に置く。
 * 無料枠のウォッチャーがこれらを叩いた場合は 402 を返す。
 *
 * 【プライバシー】
 * オーナープランでも開示レベルは変わらない。物件別に集計するだけで、
 * 個々の入居者の行動情報は一切出さない。これが入居者の受容性＝
 * オーナーの導入しやすさの決め手になる（spec 7.1）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';

/**
 * ownerプランを要求するガード。
 *
 * @param req - リクエスト
 * @param reply - レスポンス
 */
async function requireOwnerPlan(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const res = await query<{ plan: string }>('SELECT plan FROM watchers WHERE id = $1', [
    req.watcherId,
  ]);
  if (res.rows[0]?.plan !== 'owner') {
    return reply.code(402).send({
      error: 'payment_required',
      message: 'この機能はオーナープランでご利用いただけます',
    });
  }
}

/**
 * CSVのセルをエスケープする。
 *
 * 【CSVインジェクション対策】
 * '=' '+' '-' '@' で始まる値は Excel が数式として解釈し、
 * 開いた人の端末で任意コマンドが動く危険がある。
 * オーナーがダウンロードして開くファイルなので必ず無害化する。
 *
 * @param value - セルの値
 * @returns エスケープ済み文字列
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);

  // 数式として解釈されうる先頭文字を無害化する
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;

  // ダブルクォート・カンマ・改行を含む場合はクォートで囲む
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;

  return s;
}

/**
 * オーナープラン向けルートを登録する。
 *
 * @param app - fastify インスタンス
 */
export default async function ownerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/owner/dashboard — 物件別サマリ
   *
   * 例:「メゾン青葉: 6人中 生存6」（flutter spec 4.3）
   */
  app.get(
    '/v1/owner/dashboard',
    { preHandler: [app.requireWatcher, requireOwnerPlan] },
    async (req, reply) => {
      const res = await query(
        `SELECT COALESCE(c.property_tag, '(未分類)') AS property_tag,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE c.status = 'ALIVE')::int      AS alive,
                COUNT(*) FILTER (WHERE c.status = 'WATCH')::int      AS watch,
                COUNT(*) FILTER (WHERE c.status = 'CONFIRMING')::int AS confirming,
                COUNT(*) FILTER (WHERE c.status = 'ALERT')::int      AS alert,
                COUNT(*) FILTER (WHERE c.status = 'SOS')::int        AS sos
           FROM clients c
           JOIN watch_links l ON l.client_id = c.id
          WHERE l.watcher_id = $1
          GROUP BY COALESCE(c.property_tag, '(未分類)')
          ORDER BY 1`,
        [req.watcherId],
      );

      return reply.send({ properties: res.rows });
    },
  );

  /**
   * GET /v1/owner/alerts.csv — アラート履歴CSV
   *
   * オーナーが入居者や遺族に提示できる証跡。
   * 状態遷移のみを出力し、行動情報は含めない。
   */
  app.get(
    '/v1/owner/alerts.csv',
    { preHandler: [app.requireWatcher, requireOwnerPlan] },
    async (req, reply) => {
      const res = await query<{
        display_name: string;
        property_tag: string | null;
        from_status: string | null;
        to_status: string;
        created_at: Date;
      }>(
        `SELECT c.display_name,
                c.property_tag,
                a.detail->>'from' AS from_status,
                a.detail->>'to'   AS to_status,
                a.created_at
           FROM audit_log a
           JOIN clients c ON c.id = a.client_id
           JOIN watch_links l ON l.client_id = c.id
          WHERE l.watcher_id = $1
            AND a.event = 'status_change'
            AND a.detail->>'to' IN ('ALERT', 'SOS')
          ORDER BY a.created_at DESC
          LIMIT 5000`,
        [req.watcherId],
      );

      const header = ['発生日時', '物件', '対象者', '遷移前', '遷移後'].map(csvCell).join(',');
      const lines = res.rows.map((r) =>
        [
          r.created_at.toISOString(),
          r.property_tag ?? '',
          r.display_name,
          r.from_status ?? '',
          r.to_status,
        ]
          .map(csvCell)
          .join(','),
      );

      // BOM を付けて Excel で文字化けしないようにする（日本語環境の実務上必須）
      const csv = '﻿' + [header, ...lines].join('\r\n');

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="mimamori-alerts.csv"')
        .send(csv);
    },
  );

  /**
   * GET /v1/owner/report — 月次見守り稼働レポート
   *
   * 「今月の見守り稼働率99.8%」— オーナーが入居者や遺族に提示できる証跡
   * （flutter spec 4.3）。
   *
   * 稼働率の定義: 対象期間のうち、判定ジョブが正常稼働していた時間の割合。
   * service_outages に記録された停止時間を差し引いて算出する。
   * 「黙って再開しない」原則（spec 7）と同じく、停止を隠さず数字に反映する。
   */
  app.get(
    '/v1/owner/report',
    { preHandler: [app.requireWatcher, requireOwnerPlan] },
    async (req, reply) => {
      // 直近30日を対象期間とする
      const periodMinutes = 30 * 24 * 60;

      const outage = await query<{ total_gap: number }>(
        `SELECT COALESCE(SUM(gap_minutes), 0)::int AS total_gap
           FROM service_outages
          WHERE detected_at >= now() - interval '30 days'`,
      );
      const gap = outage.rows[0]?.total_gap ?? 0;
      const uptimeRatio = Math.max(0, (periodMinutes - gap) / periodMinutes);

      const clients = await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM watch_links WHERE watcher_id = $1`,
        [req.watcherId],
      );

      const alerts = await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM audit_log a
           JOIN watch_links l ON l.client_id = a.client_id
          WHERE l.watcher_id = $1
            AND a.event = 'status_change'
            AND a.detail->>'to' = 'ALERT'
            AND a.created_at >= now() - interval '30 days'`,
        [req.watcherId],
      );

      return reply.send({
        period_days: 30,
        // 小数第1位まで（「99.8%」表記のため）
        uptime_percent: Number((uptimeRatio * 100).toFixed(1)),
        outage_minutes: gap,
        clients_count: clients.rows[0]?.count ?? 0,
        alerts_count: alerts.rows[0]?.count ?? 0,
      });
    },
  );

  /**
   * PUT /v1/clients/:id/property-tag — 物件タグの設定
   *
   * オーナープランの物件グルーピング用。
   */
  app.put(
    '/v1/clients/:id/property-tag',
    { preHandler: [app.requireWatcher, requireOwnerPlan] },
    async (req, reply) => {
      const { z } = await import('zod');
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ property_tag: z.string().max(100).nullable() }).safeParse(req.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      // 権限のあるクライアントのみ更新できる（IDOR対策）
      const res = await query(
        `UPDATE clients SET property_tag = $3
          WHERE id = $1
            AND EXISTS (
              SELECT 1 FROM watch_links l
               WHERE l.client_id = clients.id AND l.watcher_id = $2
            )`,
        [params.data.id, req.watcherId, body.data.property_tag],
      );

      if ((res.rowCount ?? 0) === 0) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ ok: true });
    },
  );
}
