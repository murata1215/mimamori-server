/**
 * センサー管理API（Phase 2）。
 *
 * ウォッチャーが物理デバイス（SwitchBot・電力メーター）を
 * クライアントへ紐づけるための経路。この紐づけが無いと Webhook を受けても
 * 「誰の見守りのイベントか」を解決できず、events へ入れられない。
 *
 * 【このファイルのプライバシー上の注意】
 * センサーは行動そのものを観測する装置なので、その状態を返すAPIは
 * 容易に「原則1: プライバシー最小開示」を破る。
 * 特に last_event_at（＝玄関が最後に開いた時刻）は、まさにウォッチャーへ
 * 開示してはならない行動詳細そのものである。
 * ここで返してよいのは「設定情報」だけであり、「観測結果」は一切返さない。
 * その境界を zod のレスポンススキーマで機械的に固定する。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import {
  SENSOR_SOURCE_TYPES,
  SOURCE_DEFINITIONS,
  confidenceOf,
  isHighConfidence,
} from '../engine/sources.js';
import { audit } from '../lib/audit.js';
import { createWatchLink, checkClientQuota } from '../lib/plan.js';
import { canWatch, sendValidated } from '../lib/watcher-guard.js';

/**
 * センサー1件のレスポンススキーマ。
 *
 * 【変更禁止】last_event_at をここに足してはならない。
 * 「玄関センサーの最終イベント時刻」は本人の行動履歴であり、
 * ウォッチャーに開示してよい情報の範囲を明確に超える。
 * 運用でセンサーの死活を見たい場合は psql / journald 側で見ること。
 */
const sensorSchema = z.object({
  id: z.string().uuid(),
  source_type: z.string(),
  /** ソース種別の人間向けラベル（設定UI用） */
  source_label: z.string(),
  display_name: z.string().nullable(),
  enabled: z.boolean(),
  /**
   * このソースが「本人の行動」とみなせる信頼度か。
   * 弱シグナル扱いのセンサー（電力メーター）は、それ単体では
   * 生存の証明にならないことをウォッチャーへ正直に伝える必要がある
   * （「付けたのに見守ってくれない」という誤解を防ぐ）。
   */
  is_primary_signal: z.boolean(),
  created_at: z.date(),
});

const sensorListSchema = z.array(sensorSchema);

/** センサー登録リクエスト */
const registerSensorSchema = z.object({
  source_type: z.enum(SENSOR_SOURCE_TYPES),
  /**
   * デバイス識別子（SwitchBot: deviceMac など）。
   * confidence を受け取らないのは意図的（sources.ts の confidenceOf 参照）。
   */
  source_id: z.string().min(1).max(200),
  display_name: z.string().max(100).optional(),
});

/** センサー更新リクエスト */
const updateSensorSchema = z.object({
  display_name: z.string().max(100).optional(),
  enabled: z.boolean().optional(),
});

/** センサーのみクライアント作成リクエスト（Phase 2: has_app=false 物件） */
const sensorOnlyClientSchema = z.object({
  display_name: z.string().min(1).max(100),
  /**
   * 同意した文言のバージョン。必須。
   *
   * 【法務上の注意】(spec 7.1)
   * アプリ経由のペアリングでは本人が端末を操作して同意するが、
   * センサーのみクライアントには本人が操作する画面が存在しない。
   * ここで記録されるのは「ウォッチャーが、本人の同意を取得済みであると申告した」
   * 事実である。同意取得の実体はサービス外（書面等）で担保されなければならない。
   * この違いは監査ログに consent_by: 'watcher_declaration' として明示的に残す。
   */
  consent_version: z.string().min(1).max(50),
  property_tag: z.string().max(100).optional(),
});

/** UUIDパラメータ */
const idParamSchema = z.object({ id: z.string().uuid() });
const sensorParamSchema = z.object({ id: z.string().uuid(), sensorId: z.string().uuid() });

/**
 * センサー管理ルートを登録する。
 *
 * @param app - fastify インスタンス
 */
export default async function sensorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/clients/sensor-only — センサーのみクライアントを作成（Phase 2, spec 8）
   *
   * スマホを持たない/持てない人を見守るための経路。
   * ペアリングコードを使わない（提出する端末が存在しないため）。
   * has_app=false で作られたクライアントは判定エンジン側で
   * CONFIRMING をスキップする別プロファイルになる（実装済み・state.ts）。
   */
  app.post('/v1/clients/sensor-only', { preHandler: app.requireWatcher }, async (req, reply) => {
    const parsed = sensorOnlyClientSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { display_name, consent_version, property_tag } = parsed.data;
    const watcherId = req.watcherId!;

    // 課金枠の判定はペアリング経路と同じ。
    // センサー経由なら無料で増やせる、という抜け道を作らない。
    const quota = await checkClientQuota(watcherId);
    if (quota.exceedsFreeTier) {
      return reply.code(402).send({
        error: 'payment_required',
        message: '3人目以降の見守りには課金が必要です',
        current_count: quota.currentCount,
      });
    }

    const result = await withTransaction(async (client) => {
      // last_alive_event_at = now() にするのは、作成直後に
      // 「最終生存イベントから15時間経過」と判定されるのを防ぐため（ペアリングと同じ）。
      const clientRes = await client.query<{ id: string }>(
        `INSERT INTO clients (display_name, consent_version, consent_at, threshold_minutes,
                              last_alive_event_at, status, status_changed_at,
                              has_app, property_tag)
         VALUES ($1, $2, now(), $3, now(), 'ALIVE', now(), false, $4)
         RETURNING id`,
        [display_name, consent_version, config.DEFAULT_THRESHOLD_MINUTES, property_tag ?? null],
      );
      const clientId = clientRes.rows[0]!.id;

      const billable = await createWatchLink(client, watcherId, clientId);

      await audit(
        clientId,
        'client_paired',
        {
          watcher_id: watcherId,
          consent_version,
          // アプリ経由の本人同意ではないことを証跡に明示する。
          // 紛争時に「本人が同意したのか」を後から区別できなければ意味がない。
          consent_by: 'watcher_declaration',
          has_app: false,
          billable,
          initial_threshold_minutes: config.DEFAULT_THRESHOLD_MINUTES,
        },
        client,
      );

      return clientId;
    });

    return reply.code(201).send({
      client_id: result,
      has_app: false,
      // センサーを1つも登録していない状態では見守りが成立しない。
      // 「作成できた＝見守れている」と誤解させないため明示する。
      message: 'センサーを登録するまで見守りは開始されません',
    });
  });

  /**
   * POST /v1/clients/:id/sensors — センサーを登録
   */
  app.post('/v1/clients/:id/sensors', { preHandler: app.requireWatcher }, async (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const parsed = registerSensorSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    // IDOR対策。権限が無ければ存在を漏らさないため 404。
    if (!(await canWatch(req.watcherId!, params.data.id))) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const { source_type, source_id, display_name } = parsed.data;

    // confidence はサーバーが決める。リクエストからは受け取らない
    // （低信頼ソースが自分を高信頼と申告できてはならない）。
    const confidence = confidenceOf(source_type);

    try {
      const res = await query<{ id: string }>(
        `INSERT INTO client_sensors (client_id, source_type, source_id, confidence, display_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [params.data.id, source_type, source_id, confidence, display_name ?? null],
      );

      await audit(params.data.id, 'sensor_registered', {
        watcher_id: req.watcherId,
        source_type,
        confidence,
        // 【注意】source_id（MACアドレス）は監査ログに残してよい。
        // これは機器の識別子であって本人の行動情報ではない。
        source_id,
      });

      return reply.code(201).send({
        id: res.rows[0]!.id,
        source_type,
        is_primary_signal: isHighConfidence(confidence),
      });
    } catch (err) {
      // source_id の UNIQUE 制約違反 = 既に別（or同じ）クライアントに登録済み。
      // 【重要】「どのクライアントに登録済みか」を返してはならない。
      // 他人の見守りにそのデバイスが使われている事実を漏らすことになる。
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({
          error: 'sensor_already_registered',
          message: 'このデバイスは既に登録されています',
        });
      }
      throw err;
    }
  });

  /**
   * GET /v1/clients/:id/sensors — センサー一覧
   *
   * 返すのは設定情報のみ。観測結果（最終イベント時刻等）は返さない。
   */
  app.get('/v1/clients/:id/sensors', { preHandler: app.requireWatcher }, async (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    if (!(await canWatch(req.watcherId!, params.data.id))) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // SELECT で last_event_at を取らない。
    // 取ってからスキーマで落とすのではなく、そもそもDBから持ち出さない
    // （うっかり別のレスポンスへ混ぜる事故の余地を無くす）。
    const res = await query<{
      id: string;
      source_type: string;
      display_name: string | null;
      enabled: boolean;
      confidence: number;
      created_at: Date;
    }>(
      `SELECT id, source_type, display_name, enabled, confidence, created_at
         FROM client_sensors
        WHERE client_id = $1
        ORDER BY created_at`,
      [params.data.id],
    );

    const items = res.rows.map((r) => ({
      id: r.id,
      source_type: r.source_type,
      source_label: SOURCE_DEFINITIONS[r.source_type]?.label ?? r.source_type,
      display_name: r.display_name,
      enabled: r.enabled,
      is_primary_signal: isHighConfidence(r.confidence),
      created_at: r.created_at,
    }));

    return sendValidated(reply, sensorListSchema, items);
  });

  /**
   * PUT /v1/clients/:id/sensors/:sensorId — センサーの表示名・有効/無効を更新
   */
  app.put(
    '/v1/clients/:id/sensors/:sensorId',
    { preHandler: app.requireWatcher },
    async (req, reply) => {
      const params = sensorParamSchema.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });

      const parsed = updateSensorSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }

      if (!(await canWatch(req.watcherId!, params.data.id))) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // COALESCE で「渡されなかったフィールドは既存値のまま」にする。
      // client_id も条件に入れることで、他人のセンサーIDを指定した更新を防ぐ
      // （canWatch は :id の権限しか見ていないため、ここも必ず絞る）。
      const res = await query(
        `UPDATE client_sensors
            SET display_name = COALESCE($3, display_name),
                enabled      = COALESCE($4, enabled)
          WHERE id = $1 AND client_id = $2`,
        [
          params.data.sensorId,
          params.data.id,
          parsed.data.display_name ?? null,
          parsed.data.enabled ?? null,
        ],
      );

      if ((res.rowCount ?? 0) === 0) return reply.code(404).send({ error: 'not_found' });

      if (parsed.data.enabled !== undefined) {
        await audit(params.data.id, 'sensor_updated', {
          watcher_id: req.watcherId,
          sensor_id: params.data.sensorId,
          enabled: parsed.data.enabled,
        });
      }

      return reply.send({ ok: true });
    },
  );

  /**
   * DELETE /v1/clients/:id/sensors/:sensorId — センサーの登録解除
   *
   * 削除後、そのデバイスからの Webhook は 404 になり events へ入らなくなる。
   */
  app.delete(
    '/v1/clients/:id/sensors/:sensorId',
    { preHandler: app.requireWatcher },
    async (req, reply) => {
      const params = sensorParamSchema.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });

      if (!(await canWatch(req.watcherId!, params.data.id))) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const res = await query(
        'DELETE FROM client_sensors WHERE id = $1 AND client_id = $2 RETURNING source_type',
        [params.data.sensorId, params.data.id],
      );

      if ((res.rowCount ?? 0) === 0) return reply.code(404).send({ error: 'not_found' });

      // センサーのみクライアント（has_app=false）から最後のセンサーを外すと、
      // 見守る手段が完全に無くなる。黙って「見守っているつもり」にさせないため警告を返す。
      // アプリありのクライアントはハートビートという経路が残るので警告しない。
      const remaining = await query<{ has_app: boolean; enabled_count: number }>(
        `SELECT c.has_app,
                (SELECT COUNT(*)::int FROM client_sensors s
                  WHERE s.client_id = c.id AND s.enabled) AS enabled_count
           FROM clients c
          WHERE c.id = $1`,
        [params.data.id],
      );
      const row = remaining.rows[0];
      const noSignalSource = row ? !row.has_app && row.enabled_count === 0 : false;

      await audit(params.data.id, 'sensor_removed', {
        watcher_id: req.watcherId,
        sensor_id: params.data.sensorId,
      });

      return reply.send({
        ok: true,
        ...(noSignalSource
          ? { warning: '有効なセンサーが無くなりました。このクライアントは見守れません' }
          : {}),
      });
    },
  );
}
