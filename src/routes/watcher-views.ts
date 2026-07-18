/**
 * ウォッチャー向け参照API。
 *
 * 【このファイルの最重要責務】(原則1: プライバシー最小開示)
 * ウォッチャーに見えてよいのは「生存 / 注視 / 警告 / SOS」の4段階ステータスのみ。
 * 位置情報・行動履歴・操作時刻・センサーの生データは一切開示しない。
 * 唯一の例外は SOS 発動時の位置情報（本人の意思表示であるため）。
 *
 * この原則をコメントや慣習ではなく、zod のレスポンススキーマで機械的に強制する
 * （spec 6: 「レスポンススキーマをzodで固定」）。
 * DBに新しいカラムを足しても、スキーマを通らない限り漏れ出さない。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { canWatch, sendValidated } from '../lib/watcher-guard.js';

/**
 * クライアント一覧の要素スキーマ。
 *
 * 【開示ポリシー】(プロダクトオーナー決定 2026-07-19)
 * 見守りの中核価値は「本人が最後に操作した時刻」の可視化。
 * **時刻のみ（15分粒度・内容なし）** の開示は許可する。
 * 操作内容（アプリ名・URL・開閉状態）の開示は引き続き禁止。
 * 既に日次活動サマリ（画面点灯回数・利用スロット数）を開示しており整合する。
 *
 * ここにフィールドを追加する場合、「見守られる本人に見られて構わない情報か」を
 * 必ず検討すること。閾値・生データ・行動詳細は返してはならない。
 */
const clientListItemSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  status: z.enum(['ALIVE', 'WATCH', 'CONFIRMING', 'ALERT', 'SOS']),
  status_changed_at: z.date(),
  /**
   * 最後の「生存イベント」の発生時刻（occurred_at ベース）。
   * screen_on_count > 0 || had_app_usage = true || had_movement = true のHBの時刻。
   * = 本人が最後に端末を操作した時刻（15分粒度）。ペアリング直後は null の可能性あり。
   */
  last_activity_at: z.date().nullable(),
  /**
   * 端末が最後にサーバーと通信した時刻。
   * 操作有無を問わずハートビートが届くたびに更新される。
   * 「端末は動いているか」の目安として表示する（設定問題と同種の情報）。
   */
  last_seen_at: z.date().nullable(),
  /**
   * 「設定に問題」表示用のフラグ。
   * これは端末の設定状態であって本人の行動情報ではないため開示してよい。
   */
  has_issue: z.boolean(),
  property_tag: z.string().nullable(),
});

const clientListSchema = z.array(clientListItemSchema);

/**
 * ステータス遷移履歴の要素スキーマ。
 *
 * 粒度は「遷移のみ」。「◯月◯日 注視→生存」レベルに留める（flutter spec 4.1）。
 * 遷移の理由（threshold_minutes 等）は audit_log には残すが、
 * ウォッチャーには返さない（生活サイクルの推測材料になるため）。
 */
const statusHistoryItemSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  changed_at: z.date(),
});

/**
 * 日次活動サマリの要素スキーマ。
 *
 * 【プライバシー原則】
 * 返すのは日単位の集計値のみ。時間帯別の詳細・操作時刻・アプリ名は返さない。
 * active_buckets は「6つの4h枠のうち何枠で活動があったか」であり、
 * 「何時に活動したか」は推測できない粒度に留める。
 */
const activityDaySchema = z.object({
  /** 日付（Asia/Tokyo 基準、YYYY-MM-DD） */
  date: z.string(),
  /** スクリーンON回数の合計 */
  screen_on_count: z.number().int(),
  /** アプリ利用ありのスロット数（15分単位） */
  app_usage_slots: z.number().int(),
  /** 移動ありのスロット数（15分単位） */
  movement_slots: z.number().int(),
  /** 受信したハートビート数 */
  heartbeat_count: z.number().int(),
  /** 活動があった時間帯バケット数（4h刻み、0-6） */
  active_buckets: z.number().int(),
  /** バッテリー最小値 */
  battery_min: z.number().int().nullable(),
  /** バッテリー最大値 */
  battery_max: z.number().int().nullable(),
  /** 充電操作回数（is_charging が false→true に遷移した回数） */
  charging_events: z.number().int(),
  /** その日の歩数（step_count の最大値 = 本日累計の最大値） */
  step_count: z.number().int().nullable(),
});

const activityResponseSchema = z.object({
  client_id: z.string().uuid(),
  days: z.array(activityDaySchema),
});

/**
 * SOS詳細スキーマ。位置情報を含む唯一のレスポンス。
 */
const sosDetailSchema = z.object({
  id: z.string().uuid(),
  client_id: z.string().uuid(),
  client_name: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  battery_level: z.number().nullable(),
  fired_at: z.date(),
  resolved_at: z.date().nullable(),
  /** 位置情報の測位時刻。null = fired_at と同時（キャッシュではない）。 */
  location_captured_at: z.date().nullable(),
});



/**
 * ウォッチャー向け参照ルートを登録する。
 *
 * @param app - fastify インスタンス
 */
export default async function watcherViewRoutes(app: FastifyInstance): Promise<void> {
  /**
   * DELETE /v1/clients/:client_id — 見守り紐づけの解除
   *
   * 自分の watch_link のみ削除する。client レコード・他ウォッチャーの watch_link には触れない。
   * billable フラグは動かさない（課金の予測可能性の原則）。
   * 最後のウォッチャーが解除した場合、client は残るが通知先ゼロになる。
   */
  app.delete('/v1/clients/:client_id', { preHandler: app.requireWatcher }, async (req, reply) => {
    const params = z.object({ client_id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });

    const watcherId = req.watcherId!;
    const clientId = params.data.client_id;

    const res = await query(
      'DELETE FROM watch_links WHERE watcher_id = $1 AND client_id = $2',
      [watcherId, clientId],
    );

    if ((res.rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: 'not_found' });
    }

    await audit(clientId, 'watch_link_removed', {
      watcher_id: watcherId,
    });

    return reply.send({ ok: true });
  });

  /**
   * GET /v1/clients — 見守り対象の一覧
   *
   * ステータス・最終活動時刻・最終通信時刻を返す。
   * 操作内容（アプリ名・URL）やセンサー生データは返さない。
   *
   * has_issue の判定はサーバー側で行う（端末沈黙 = 45分以上ハートビートなし）。
   * これは「端末の設定/接続状態」なので開示してよい。
   */
  app.get('/v1/clients', { preHandler: app.requireWatcher }, async (req, reply) => {
    const res = await query(
      `SELECT c.id,
              c.display_name,
              c.status,
              c.status_changed_at,
              c.property_tag,
              c.last_alive_event_at AS last_activity_at,
              c.last_heartbeat_at AS last_seen_at,
              -- 端末沈黙の判定。閾値の生値は返さない。
              (c.has_app AND (
                 c.last_heartbeat_at IS NULL
                 OR c.last_heartbeat_at < now() - interval '45 minutes'
               )) AS has_issue
         FROM clients c
         JOIN watch_links l ON l.client_id = c.id
        WHERE l.watcher_id = $1
        ORDER BY
          -- 緊急度の高い順に並べる。ウォッチャーが最初に見るべきものを上に。
          CASE c.status
            WHEN 'SOS' THEN 0
            WHEN 'ALERT' THEN 1
            WHEN 'CONFIRMING' THEN 2
            WHEN 'WATCH' THEN 3
            ELSE 4
          END,
          c.display_name`,
      [req.watcherId],
    );

    return sendValidated(reply, clientListSchema, res.rows);
  });

  /**
   * GET /v1/clients/:id/status-history — ステータス遷移履歴
   *
   * 粒度は遷移のみ。audit_log の status_change から再構成する。
   */
  app.get('/v1/clients/:id/status-history', { preHandler: app.requireWatcher }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });

    if (!(await canWatch(req.watcherId!, params.data.id))) {
      // 権限がない場合、存在有無を漏らさないため404を返す（403ではなく）
      return reply.code(404).send({ error: 'not_found' });
    }

    // detail から from/to のみを取り出す。
    // detail には threshold_minutes 等の判定内部情報も入っているが、
    // それらは返さない（生活サイクルの推測材料になる）。
    const res = await query(
      `SELECT detail->>'from' AS from, detail->>'to' AS to, created_at AS changed_at
         FROM audit_log
        WHERE client_id = $1 AND event = 'status_change'
        ORDER BY created_at DESC
        LIMIT 100`,
      [params.data.id],
    );

    return sendValidated(reply, z.array(statusHistoryItemSchema), res.rows);
  });

  /**
   * GET /v1/clients/:client_id/sos/active — アクティブ（未解決）SOS の取得
   *
   * FCM 通知を受け取れなかった場合でも、クライアント一覧で status='SOS' を
   * 検出した Flutter が incident_id を取得して SOS 画面に遷移できるようにする。
   * 複数未解決がある場合は最新の1件を返す。
   */
  app.get('/v1/clients/:client_id/sos/active', { preHandler: app.requireWatcher }, async (req, reply) => {
    const params = z.object({ client_id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });

    if (!(await canWatch(req.watcherId!, params.data.client_id))) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const res = await query(
      `SELECT s.id, s.client_id, c.display_name AS client_name,
              s.latitude, s.longitude, s.battery_level, s.fired_at, s.resolved_at,
              s.location_captured_at
         FROM sos_incidents s
         JOIN clients c ON c.id = s.client_id
        WHERE s.client_id = $1
          AND s.resolved_at IS NULL
          AND s.purge_after > now()
        ORDER BY s.fired_at DESC
        LIMIT 1`,
      [params.data.client_id],
    );

    const incident = res.rows[0];
    if (!incident) {
      return reply.code(404).send({ error: 'not_found', message: 'アクティブなSOSはありません' });
    }

    return sendValidated(reply, sosDetailSchema, incident);
  });

  /**
   * GET /v1/sos/:id — SOS詳細（位置情報を含む）
   *
   * resolved後・purge後は404（flutter spec 4.2:
   * 「SOS解決後は地図へのアクセス不可」）。
   * 位置情報の露出時間を最小化するのが目的。
   */
  app.get('/v1/sos/:id', { preHandler: app.requireWatcher }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });

    const res = await query(
      `SELECT s.id, s.client_id, c.display_name AS client_name,
              s.latitude, s.longitude, s.battery_level, s.fired_at, s.resolved_at,
              s.location_captured_at
         FROM sos_incidents s
         JOIN clients c ON c.id = s.client_id
         JOIN watch_links l ON l.client_id = s.client_id
        WHERE s.id = $1
          AND l.watcher_id = $2
          AND s.resolved_at IS NULL
          AND s.purge_after > now()`,
      [params.data.id, req.watcherId],
    );

    const incident = res.rows[0];
    if (!incident) {
      return reply.code(404).send({ error: 'not_found', message: 'SOS情報は参照できません' });
    }

    return sendValidated(reply, sosDetailSchema, incident);
  });

  /**
   * POST /v1/sos/:id/resolve — SOSを解決済みにする
   *
   * 解決すると位置情報へのアクセスが即座に不可になる。
   * また、クライアントの状態を ALIVE へ戻す
   * （SOSは自動復帰しない唯一の状態なので、ここでしか戻せない）。
   */
  app.post('/v1/sos/:id/resolve', { preHandler: app.requireWatcher }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });

    // 誤報率KPIの算出に使う。
    // 「無事だった」= 誤報、「実際に異常だった」= 正報として集計する（spec 9）。
    const body = z
      .object({ outcome: z.enum(['was_safe', 'was_real']).optional() })
      .safeParse(req.body ?? {});
    const outcome = body.success ? body.data.outcome : undefined;

    const res = await query<{ client_id: string }>(
      `UPDATE sos_incidents s
          SET resolved_at = now(), resolved_by = $2
        WHERE s.id = $1
          AND s.resolved_at IS NULL
          AND EXISTS (
            SELECT 1 FROM watch_links l
             WHERE l.client_id = s.client_id AND l.watcher_id = $2
          )
        RETURNING s.client_id`,
      [params.data.id, req.watcherId],
    );

    const row = res.rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });

    // SOS状態を解除して ALIVE へ戻す。
    // 他にSOS中のインシデントが残っている場合は戻さない（複数SOS発動の考慮）。
    //
    // last_alive_event_at も now() に更新する。
    // これがないと、SOS発動から解決までの経過時間がそのまま「無操作時間」として
    // 残り、解決した直後に判定ジョブが CONFIRMING/ALERT を発報する。
    const revived = await query(
      `UPDATE clients
          SET status = 'ALIVE',
              status_changed_at = now(),
              last_alive_event_at = GREATEST(last_alive_event_at, now()),
              confirming_since = NULL,
              last_alert_notified_at = NULL,
              silent_push_sent_at = NULL
        WHERE id = $1
          AND status = 'SOS'
          AND NOT EXISTS (
            SELECT 1 FROM sos_incidents
             WHERE client_id = $1 AND resolved_at IS NULL
          )`,
      [row.client_id],
    );

    await audit(row.client_id, 'sos_resolved', {
      incident_id: params.data.id,
      resolved_by: req.watcherId,
      outcome: outcome ?? null,
    });

    // 実際に状態が戻った場合のみ遷移として記録する（履歴に載せるため）
    if ((revived.rowCount ?? 0) > 0) {
      await audit(row.client_id, 'status_change', {
        from: 'SOS',
        to: 'ALIVE',
        reason: 'sos_resolved',
        resolved_by: req.watcherId,
      });
    }

    return reply.send({ ok: true });
  });

  /**
   * POST /v1/clients/:id/resolve-alert — ALERTを解決済みにする
   *
   * 誤報率KPI（ALERT発報のうち「無事だった」でクローズした割合）の
   * 計測に必要（spec 9）。この記録がないとPhase 1の合否判定ができない。
   */
  app.post('/v1/clients/:id/resolve-alert', { preHandler: app.requireWatcher }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });

    const body = z.object({ outcome: z.enum(['was_safe', 'was_real']) }).safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: 'outcome は was_safe / was_real のいずれか' });
    }

    if (!(await canWatch(req.watcherId!, params.data.id))) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const res = await query<{ status: string }>(
      `SELECT status FROM clients WHERE id = $1`,
      [params.data.id],
    );
    const current = res.rows[0]?.status;
    if (current !== 'ALERT') {
      return reply.code(409).send({ error: 'not_in_alert', message: '警告状態ではありません' });
    }

    // ウォッチャーが「無事だった」と確認した場合のみ ALIVE へ戻す。
    // 「実際に異常だった」場合は状態を維持する（対応中であることを示す）。
    if (body.data.outcome === 'was_safe') {
      await query(
        `UPDATE clients
            SET status = 'ALIVE',
                status_changed_at = now(),
                last_alive_event_at = now(),
                confirming_since = NULL,
                last_alert_notified_at = NULL,
                silent_push_sent_at = NULL
          WHERE id = $1 AND status = 'ALERT'`,
        [params.data.id],
      );
      await audit(params.data.id, 'status_change', {
        from: 'ALERT',
        to: 'ALIVE',
        reason: 'watcher_resolved_was_safe',
        resolved_by: req.watcherId,
        // 誤報率KPIの集計キー
        false_alarm: true,
      });
    } else {
      await audit(params.data.id, 'status_change', {
        from: 'ALERT',
        to: 'ALERT',
        reason: 'watcher_confirmed_real',
        resolved_by: req.watcherId,
        false_alarm: false,
      });
    }

    return reply.send({ ok: true });
  });

  /**
   * GET /v1/clients/:client_id/activity — 日次活動サマリ
   *
   * 【プライバシー原則】(原則1)
   * 日単位の集計値のみ返す。操作時刻・行動詳細・個別イベントは返さない。
   * zod スキーマで固定し、ここに列挙した以外のフィールドは漏れ出さない。
   *
   * days 配列は古い日→新しい日の順（時系列順）。
   * データが無い日は 0 埋めで含める（Flutter 側で日ごとのカードを一定数表示するため）。
   */
  app.get('/v1/clients/:client_id/activity', { preHandler: app.requireWatcher }, async (req, reply) => {
    const params = z.object({ client_id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });

    const queryParams = z.object({
      days: z.coerce.number().int().min(1).max(7).default(3),
    }).safeParse(req.query);
    const days = queryParams.success ? queryParams.data.days : 3;

    const clientId = params.data.client_id;

    if (!(await canWatch(req.watcherId!, clientId))) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // generate_series で days 分の日付を生成し、LEFT JOIN で 0 埋め
    // charging_events: is_charging の false→true 遷移をウィンドウ関数で検出
    const res = await query<{
      date: string;
      screen_on_count: string;
      app_usage_slots: string;
      movement_slots: string;
      heartbeat_count: string;
      active_buckets: string;
      battery_min: number | null;
      battery_max: number | null;
      charging_events: string;
      step_count: number | null;
    }>(
      `WITH date_range AS (
         SELECT d::date AS day
         FROM generate_series(
           (now() AT TIME ZONE 'Asia/Tokyo')::date - ($2 - 1),
           (now() AT TIME ZONE 'Asia/Tokyo')::date,
           '1 day'::interval
         ) AS d
       ),
       ordered_events AS (
         SELECT
           (occurred_at AT TIME ZONE 'Asia/Tokyo')::date AS day,
           meta,
           occurred_at,
           LAG((meta->>'is_charging')::boolean) OVER (
             PARTITION BY (occurred_at AT TIME ZONE 'Asia/Tokyo')::date
             ORDER BY occurred_at
           ) AS prev_is_charging
         FROM events
         WHERE client_id = $1
           AND event_type = 'heartbeat'
           AND occurred_at >= (now() AT TIME ZONE 'Asia/Tokyo')::date - ($2 - 1)
       ),
       daily AS (
         SELECT
           day,
           COALESCE(SUM((meta->>'screen_on_count')::int), 0) AS screen_on_count,
           COUNT(*) FILTER (WHERE (meta->>'had_app_usage')::boolean = true) AS app_usage_slots,
           COUNT(*) FILTER (WHERE (meta->>'had_movement')::boolean = true) AS movement_slots,
           COUNT(*) AS heartbeat_count,
           COUNT(DISTINCT (EXTRACT(hour FROM occurred_at AT TIME ZONE 'Asia/Tokyo')::int / 4)) AS active_buckets,
           MIN((meta->>'battery_level')::int) AS battery_min,
           MAX((meta->>'battery_level')::int) AS battery_max,
           COUNT(*) FILTER (
             WHERE (meta->>'is_charging')::boolean = true
               AND (prev_is_charging IS DISTINCT FROM true)
           ) AS charging_events,
           MAX((meta->>'step_count')::int) AS step_count
         FROM ordered_events
         GROUP BY day
       )
       SELECT
         to_char(dr.day, 'YYYY-MM-DD') AS date,
         COALESCE(d.screen_on_count, 0) AS screen_on_count,
         COALESCE(d.app_usage_slots, 0) AS app_usage_slots,
         COALESCE(d.movement_slots, 0) AS movement_slots,
         COALESCE(d.heartbeat_count, 0) AS heartbeat_count,
         COALESCE(d.active_buckets, 0) AS active_buckets,
         d.battery_min,
         d.battery_max,
         COALESCE(d.charging_events, 0) AS charging_events,
         d.step_count
       FROM date_range dr
       LEFT JOIN daily d ON d.day = dr.day
       ORDER BY dr.day ASC`,
      [clientId, days],
    );

    const response = {
      client_id: clientId,
      days: res.rows.map((r) => ({
        date: r.date,
        screen_on_count: Number(r.screen_on_count),
        app_usage_slots: Number(r.app_usage_slots),
        movement_slots: Number(r.movement_slots),
        heartbeat_count: Number(r.heartbeat_count),
        active_buckets: Number(r.active_buckets),
        battery_min: r.battery_min,
        battery_max: r.battery_max,
        charging_events: Number(r.charging_events),
        step_count: r.step_count,
      })),
    };

    return sendValidated(reply, activityResponseSchema, response);
  });
}
