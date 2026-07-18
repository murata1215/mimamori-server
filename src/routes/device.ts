/**
 * クライアント端末API。
 *
 * 端末は「生存シグナルを送るだけ」。判定は一切しない（原則2）。
 * したがってこのモジュールに「異常かどうか」を判断するコードがあってはならない。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueDeviceToken } from '../auth/jwt.js';
import { config } from '../db/../config.js';
import { query, withTransaction } from '../db/pool.js';
import { ingestEvents } from '../engine/events.js';
import { audit } from '../lib/audit.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { notifyPermissionIssue, notifySos } from '../notify/dispatcher.js';

/**
 * ハートビート1件。
 *
 * 【プライバシー原則】(flutter spec 3.2)
 * サーバーに送るのは「使ったか否か」のみ。何を・どれだけ使ったかは送らない。
 * had_app_usage が boolean なのはそのため。アプリ名を受け取るフィールドを
 * 追加してはならない。
 */
const heartbeatSchema = z.object({
  /** 発生時刻。端末キュー再送でも元の時刻を保持すること。 */
  occurred_at: z.coerce.date(),
  battery_level: z.number().int().min(0).max(100).optional(),
  /** 直近15分のスクリーンON回数。回数のみ（時刻詳細は受け取らない）。 */
  screen_on_count: z.number().int().min(0).optional(),
  /** 直近のアプリ利用有無。boolean のみ。 */
  had_app_usage: z.boolean().optional(),
  app_version: z.string().max(50).optional(),
});

/**
 * ハートビートのバッチ。
 *
 * 端末はオフライン時にローカルキューへ蓄積し、復帰時にまとめて送る。
 * 上限を設けるのは、巨大なペイロードでサーバーを詰まらせないため。
 */
const heartbeatBatchSchema = z.object({
  heartbeats: z.array(heartbeatSchema).min(1).max(200),
  /**
   * 端末側の送信統計（Phase 1 の合否判定データ）。
   * ハートビート生存率の実測に使う（flutter spec 6）。
   */
  delivery_stats: z
    .object({
      sent: z.number().int().min(0).optional(),
      failed: z.number().int().min(0).optional(),
      queued: z.number().int().min(0).optional(),
    })
    .optional(),
});

/** SOS発動リクエスト */
const sosSchema = z.object({
  /**
   * 位置情報。取得失敗時は省略可（「位置不明」でも送信を優先する仕様）。
   * 【重要】位置を受け取るAPIはこれ1つだけ。他の経路で位置を受け取ってはならない。
   */
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  battery_level: z.number().int().min(0).max(100).optional(),
});

/** 権限失効の申告 */
const permissionHealthSchema = z.object({
  /** 失効している権限のリスト */
  issues: z.array(z.enum(['usage_stats', 'battery_optimization', 'notification', 'location'])),
});

/** クライアントのメール登録リクエスト */
const clientAddEmailSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
});

/** クライアントのメールログインリクエスト */
const clientLoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
  platform: z.string().min(1).max(50),
  app_version: z.string().max(50).optional(),
  fcm_token: z.string().max(500).optional(),
  consent_version: z.string().min(1).max(50),
});

/**
 * クライアント端末ルートを登録する。
 *
 * @param app - fastify インスタンス
 */
export default async function deviceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/heartbeats — ハートビートのバッチ受付
   *
   * 端末は15分周期で送る。オフライン時はキューに溜めてまとめて送る。
   */
  app.post(
    '/v1/heartbeats',
    {
      preHandler: app.requireDevice,
      config: {
        // レート制限: 15分に1回が想定。キュー再送のバーストを考慮して
        // 15分あたり20回まで許容し、それを超えたら429（spec 6）。
        rateLimit: {
          max: 20,
          timeWindow: '15 minutes',
        },
      },
    },
    async (req, reply) => {
      const parsed = heartbeatBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }

      const clientId = req.clientId!;
      const deviceId = req.deviceId!;
      const { heartbeats, delivery_stats } = parsed.data;

      const now = Date.now();
      const results = await ingestEvents(
        heartbeats.map((hb) => ({
          clientId,
          sourceType: 'phone',
          sourceId: deviceId,
          eventType: 'heartbeat' as const,
          // 未来時刻のイベントを受け付けない。
          // 端末の時計がズレていると、経過時間の計算が壊れて
          // 「永久に生存」と誤判定される。未来時刻は受信時刻に丸める。
          occurredAt: hb.occurred_at.getTime() > now ? new Date(now) : hb.occurred_at,
          meta: {
            // 判定に必要な値のみ。行動詳細は入れない。
            ...(hb.battery_level !== undefined ? { battery_level: hb.battery_level } : {}),
            ...(hb.screen_on_count !== undefined ? { screen_on_count: hb.screen_on_count } : {}),
            ...(hb.had_app_usage !== undefined ? { had_app_usage: hb.had_app_usage } : {}),
          },
        })),
      );

      // 端末の最終確認時刻とアプリバージョンを更新。
      // last_seen_at はハートビート生存率KPIの算出元（spec 9）。
      const appVersion = heartbeats.find((h) => h.app_version)?.app_version;
      await query(
        `UPDATE devices
            SET last_seen_at = now(),
                app_version = COALESCE($2, app_version)
          WHERE id = $1`,
        [deviceId, appVersion ?? null],
      );

      // 送信統計は監査ログへ（KPI計測用。件数が多いので状態変化時のみではなく
      // 統計が付いている時だけ記録する）
      if (delivery_stats) {
        await audit(clientId, 'permission_health', {
          kind: 'delivery_stats',
          device_id: deviceId,
          ...delivery_stats,
        });
      }

      return reply.send({
        accepted: results.filter((r) => r.inserted).length,
        duplicates: results.filter((r) => !r.inserted).length,
        revived: results.some((r) => r.revivedToAlive),
      });
    },
  );

  /**
   * POST /v1/sos — SOS発動
   *
   * 【最優先の同期パス】判定ジョブを介さず、即座にウォッチャーへ通知する。
   * 位置情報を受け取る唯一のエンドポイント。
   */
  app.post('/v1/sos', { preHandler: app.requireDevice }, async (req, reply) => {
    const parsed = sosSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const clientId = req.clientId!;
    const { lat, lng, battery_level } = parsed.data;

    const incidentId = await withTransaction(async (client) => {
      // 位置情報は sos_incidents にのみ保存する。
      // purge_after で30日後に物理削除される。
      const res = await client.query<{ id: string }>(
        `INSERT INTO sos_incidents (client_id, latitude, longitude, battery_level, fired_at, purge_after)
         VALUES ($1, $2, $3, $4, now(), now() + ($5 || ' days')::interval)
         RETURNING id`,
        [clientId, lat ?? null, lng ?? null, battery_level ?? null, config.SOS_PURGE_DAYS],
      );
      const id = res.rows[0]!.id;

      // 遷移前の状態を控えるのは、status-history に遷移として残すため。
      // UPDATE ... RETURNING のサブクエリで更新前の値を取ろうとしてはならない
      // （どのスナップショットを見るかが直感に反する）。明示的に先読みする。
      const prev = await client.query<{ status: string }>(
        'SELECT status FROM clients WHERE id = $1 FOR UPDATE',
        [clientId],
      );
      const previousStatus = prev.rows[0]?.status ?? null;

      // 状態を SOS へ。SOSは最優先で、どの状態からでも即座に遷移する。
      await client.query(
        `UPDATE clients SET status = 'SOS', status_changed_at = now() WHERE id = $1`,
        [clientId],
      );

      // events にも記録するが、位置は入れない（イベント抽象化の原則＋位置の隔離）
      await client.query(
        `INSERT INTO events (client_id, source_type, source_id, event_type, occurred_at, meta)
         VALUES ($1, 'phone', $2, 'sos', now(), $3)
         ON CONFLICT (client_id, source_type, event_type, occurred_at) DO NOTHING`,
        [
          clientId,
          req.deviceId,
          JSON.stringify({
            incident_id: id,
            ...(battery_level !== undefined ? { battery_level } : {}),
          }),
        ],
      );

      await audit(
        clientId,
        'sos_fired',
        {
          incident_id: id,
          // 監査ログに座標そのものは残さない（位置は sos_incidents のみ）。
          // 位置の有無だけを記録する。
          has_location: lat !== undefined && lng !== undefined,
          battery_level: battery_level ?? null,
        },
        client,
      );

      // ウォッチャーのステータス履歴に載せるため、遷移としても記録する。
      // status-history は audit_log の status_change から再構成されるため、
      // これが無いと SOS の発動が履歴に一切現れない。
      if (previousStatus !== 'SOS') {
        await audit(
          clientId,
          'status_change',
          { from: previousStatus, to: 'SOS', reason: 'sos_fired' },
          client,
        );
      }

      return id;
    });

    // 通知はトランザクション外で行う。
    // 通知の遅延・失敗でSOSの記録自体がロールバックされてはならない。
    // 通知失敗は audit_log に残り、端末側のSMSフォールバックが働く。
    await notifySos(clientId, incidentId).catch((err) => {
      console.error('[sos] ウォッチャーへの通知に失敗しました:', err);
    });

    return reply.code(201).send({ incident_id: incidentId });
  });

  /**
   * POST /v1/confirm-alive — 本人確認への応答
   *
   * 全画面通知をタップした時に呼ばれる。即 ALIVE へ復帰する。
   * この解除率90%以上がKPI（= 警告前に誤報が止まっている）。
   */
  app.post('/v1/confirm-alive', { preHandler: app.requireDevice }, async (req, reply) => {
    const clientId = req.clientId!;

    const results = await ingestEvents([
      {
        clientId,
        sourceType: 'phone',
        sourceId: req.deviceId,
        eventType: 'confirm_alive',
        occurredAt: new Date(),
      },
    ]);

    await audit(clientId, 'confirm_alive', {
      device_id: req.deviceId,
      revived: results.some((r) => r.revivedToAlive),
    });

    return reply.send({ ok: true, status: 'ALIVE' });
  });

  /**
   * POST /v1/permission-health — 権限失効の申告
   *
   * UsageStats失効等をウォッチャーへ「設定に問題」として通知する。
   * 端末が「異常判定」しているのではなく「設定状態を報告」しているだけである点に注意
   * （原則2に反しない）。
   */
  app.post('/v1/permission-health', { preHandler: app.requireDevice }, async (req, reply) => {
    const parsed = permissionHealthSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const clientId = req.clientId!;
    const { issues } = parsed.data;

    await audit(clientId, 'permission_health', {
      device_id: req.deviceId,
      issues,
    });

    // 問題がある場合のみ通知。問題が解消した申告（空配列）では通知しない。
    if (issues.length > 0) {
      await notifyPermissionIssue(clientId, issues.join(',')).catch((err) => {
        console.error('[permission-health] 通知に失敗しました:', err);
      });
    }

    return reply.send({ ok: true });
  });

  /**
   * PUT /v1/devices/me/fcm-token — 端末のFCMトークン更新
   *
   * FCMトークンはアプリ再インストール等で変わる。
   * トークンが古いと本人確認通知が届かず、誤ってALERTへ進む。
   */
  app.put('/v1/devices/me/fcm-token', { preHandler: app.requireDevice }, async (req, reply) => {
    const parsed = z.object({ fcm_token: z.string().min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    await query('UPDATE devices SET fcm_token = $2 WHERE id = $1', [
      req.deviceId,
      parsed.data.fcm_token,
    ]);
    return reply.send({ ok: true });
  });

  // ===========================================================================
  // クライアント機種変更対応
  // ===========================================================================

  /**
   * POST /v1/clients/me/email — クライアントのメール登録
   *
   * 既存クライアント（デバイストークン認証済み）にメール+パスワードを付与する。
   * 機種変更時に /v1/clients/login でログインできるようになる。
   *
   * 200: 登録成功
   * 400: バリデーションエラー
   * 409: already_registered（既にメール登録済み）/ email_taken（他クライアントが使用中）
   */
  app.post(
    '/v1/clients/me/email',
    { preHandler: app.requireDevice },
    async (req, reply) => {
      const parsed = clientAddEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { email, password } = parsed.data;
      const clientId = req.clientId!;

      // 既にメール登録済みかチェック
      const me = await query<{ email: string | null }>(
        'SELECT email FROM clients WHERE id = $1',
        [clientId],
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
          'UPDATE clients SET email = $2, password_hash = $3 WHERE id = $1',
          [clientId, normalizedEmail, password_hash],
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
   * POST /v1/clients/login — クライアントのメールログイン（機種変更用）
   *
   * メール+パスワードで認証し、同じ client_id に新デバイスを登録する。
   * 旧デバイスは全て無効化される（deactivated_at を設定）。
   *
   * 【旧端末無効化の理由】
   * 旧端末が confirm_alive を送ると ALIVE に誤復帰し死亡を見逃す（絶対ルール1違反）。
   * screen_on_count > 0 のハートビートが生存イベント扱いされる危険もある。
   *
   * 200: ログイン成功
   * 400: バリデーションエラー
   * 401: invalid_credentials
   * 429: レート制限
   */
  app.post(
    '/v1/clients/login',
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
      const parsed = clientLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { email, password, platform, app_version, fcm_token, consent_version } = parsed.data;

      // 1) email → client 検索 + パスワード検証
      const res = await query<{ id: string; password_hash: string | null }>(
        'SELECT id, password_hash FROM clients WHERE email = $1',
        [email.toLowerCase().trim()],
      );
      const client = res.rows[0];

      // ユーザー列挙攻撃対策: 存在しない場合もダミー検証で応答時間を揃える
      const DUMMY_HASH =
        'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const ok = await verifyPassword(password, client?.password_hash ?? DUMMY_HASH);

      if (!client || !ok) {
        return reply
          .code(401)
          .send({ error: 'invalid_credentials', message: 'メールアドレスまたはパスワードが違います' });
      }

      const clientId = client.id;

      // 2) 旧デバイスを全て無効化
      await query(
        'UPDATE devices SET deactivated_at = now() WHERE client_id = $1 AND deactivated_at IS NULL',
        [clientId],
      );

      // 3) 新デバイスを作成
      const deviceRes = await query<{ id: string }>(
        `INSERT INTO devices (client_id, platform, fcm_token, app_version, last_seen_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id`,
        [clientId, platform, fcm_token ?? null, app_version ?? null],
      );
      const deviceId = deviceRes.rows[0]!.id;

      // 4) consent_version / consent_at を更新
      await query(
        'UPDATE clients SET consent_version = $2, consent_at = now() WHERE id = $1',
        [clientId, consent_version],
      );

      // 5) device JWT 発行
      const device_token = issueDeviceToken(app, clientId, deviceId);

      // 6) 監査ログ
      await audit(clientId, 'client_device_login', {
        device_id: deviceId,
        platform,
        app_version: app_version ?? null,
        consent_version,
      });

      return reply.send({ client_id: clientId, device_id: deviceId, device_token });
    },
  );
}
