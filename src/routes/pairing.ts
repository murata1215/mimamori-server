/**
 * ペアリング API。
 *
 * ウォッチャーが6桁コードを発行 → クライアント端末がコードを提出して紐づく。
 * このタイミングで同意記録（consent_version / consent_at）を必ず取る。
 *
 * 【法務要件】(spec 7.1)
 * 生活パターンの検知は個人情報の取得にあたる。
 * 契約不要にはできても、同意不要にはできない。
 * したがって consent_version は必須パラメータであり、これ無しでは
 * クライアントを作成しない。
 */
import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueDeviceToken } from '../auth/jwt.js';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { FREE_TIER_LIMIT, checkClientQuota, createWatchLink, getInitialThreshold } from '../lib/plan.js';

/** ペアリングコードのTTL（分）。spec: 15分。 */
const PAIRING_CODE_TTL_MINUTES = 15;

/** ペアリング提出リクエスト */
const pairSchema = z.object({
  code: z.string().regex(/^\d{6}$/, '6桁の数字を入力してください'),
  display_name: z.string().min(1).max(100),
  /** 同意した文言のバージョン。必須。 */
  consent_version: z.string().min(1).max(50),
  platform: z.string().min(1).max(50),
  app_version: z.string().max(50).optional(),
  fcm_token: z.string().max(500).optional(),
  /**
   * オンボーディングの自己申告。
   * 「よく触る」= 10h、「あまり触らない」= 15h を初期閾値にする（spec 5.3）。
   */
  usage_frequency: z.enum(['frequent', 'occasional']).optional(),
});

/**
 * 暗号論的に安全な6桁コードを生成する。
 *
 * Math.random() を使ってはならない（予測可能なコードは、
 * 第三者が他人の見守りに割り込めることを意味する）。
 *
 * @returns 6桁のゼロ埋め文字列
 */
function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * ペアリング関連ルートを登録する。
 *
 * @param app - fastify インスタンス
 */
export default async function pairingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/pairing-codes — ペアリングコード発行（watcher権限、TTL 15分）
   *
   * 3人目以降の追加は課金対象。無料枠を超える場合は 402 を返し、
   * クライアント側でRevenueCatペイウォールを表示させる（flutter spec 4.1）。
   */
  app.post('/v1/pairing-codes', { preHandler: app.requireWatcher }, async (req, reply) => {
    const watcherId = req.watcherId!;

    // 無料プランで3人目以降を追加しようとした場合はペイウォールへ誘導。
    // ownerプランは人数無制限（従量課金）。
    // 判定は lib/plan.ts に集約（センサーのみクライアント作成経路と共通）。
    const quota = await checkClientQuota(watcherId);
    if (quota.exceedsFreeTier) {
      return reply.code(402).send({
        error: 'payment_required',
        message: '3人目以降の見守りには課金が必要です',
        current_count: quota.currentCount,
        free_limit: FREE_TIER_LIMIT,
      });
    }

    // コードの衝突に備えて数回リトライする。
    // 6桁 = 100万通り。有効なコードは高々数十件なので衝突はまれ。
    let code: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generatePairingCode();
      const res = await query(
        `INSERT INTO pairing_codes (code, watcher_id, expires_at)
         VALUES ($1, $2, now() + ($3 || ' minutes')::interval)
         ON CONFLICT (code) DO NOTHING`,
        [candidate, watcherId, PAIRING_CODE_TTL_MINUTES],
      );
      if ((res.rowCount ?? 0) > 0) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      return reply
        .code(503)
        .send({ error: 'code_generation_failed', message: 'しばらくしてからお試しください' });
    }

    return reply.code(201).send({
      code,
      expires_in_minutes: PAIRING_CODE_TTL_MINUTES,
    });
  });

  /**
   * POST /v1/clients/pair — クライアント端末がコードを提出
   *
   * 認証不要（まだトークンを持っていないため）。コード自体が認証材料になる。
   * 成功時: client作成 ＋ device作成 ＋ デバイストークン発行 ＋ 同意記録。
   */
  app.post('/v1/clients/pair', async (req, reply) => {
    const parsed = pairSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const { code, display_name, consent_version, platform, app_version, fcm_token, usage_frequency } =
      parsed.data;

    const result = await withTransaction(async (client) => {
      // コードを検証しつつロックする。
      // FOR UPDATE により、同一コードの同時提出で2つのクライアントが
      // 作られることを防ぐ。
      const codeRes = await client.query<{ watcher_id: string }>(
        `SELECT watcher_id FROM pairing_codes
          WHERE code = $1 AND used = false AND expires_at > now()
          FOR UPDATE`,
        [code],
      );
      const pairing = codeRes.rows[0];
      if (!pairing) return { error: 'invalid_code' as const };

      // 自己申告 + platform に基づく初期閾値（spec 5.3 + iOS 対応）
      const initialThreshold = getInitialThreshold(platform, usage_frequency);

      // クライアント作成。
      // last_alive_event_at を now() にするのは、ペアリング直後に
      // 「最終生存イベントから15時間経過」と判定されるのを防ぐため。
      const clientRes = await client.query<{ id: string }>(
        `INSERT INTO clients (display_name, consent_version, consent_at, threshold_minutes,
                              last_alive_event_at, status, status_changed_at)
         VALUES ($1, $2, now(), $3, now(), 'ALIVE', now())
         RETURNING id`,
        [display_name, consent_version, initialThreshold],
      );
      const clientId = clientRes.rows[0]!.id;

      // 紐づけ作成。billable（3人目以降か）は作成時点で確定する。
      const billable = await createWatchLink(client, pairing.watcher_id, clientId);

      // デバイス作成
      const deviceRes = await client.query<{ id: string }>(
        `INSERT INTO devices (client_id, platform, fcm_token, app_version, last_seen_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id`,
        [clientId, platform, fcm_token ?? null, app_version ?? null],
      );
      const deviceId = deviceRes.rows[0]!.id;

      // コードを使用済みにする（使い捨て）
      await client.query('UPDATE pairing_codes SET used = true WHERE code = $1', [code]);

      // 同意記録を監査ログにも残す（法務要件の証跡）
      await audit(
        clientId,
        'client_paired',
        {
          watcher_id: pairing.watcher_id,
          consent_version,
          platform,
          app_version: app_version ?? null,
          billable,
          initial_threshold_minutes: initialThreshold,
        },
        client,
      );

      return { clientId, deviceId };
    });

    if ('error' in result) {
      return reply.code(400).send({
        error: 'invalid_code',
        message: 'コードが無効か、有効期限が切れています',
      });
    }

    const token = issueDeviceToken(app, result.clientId, result.deviceId);
    return reply.code(201).send({
      client_id: result.clientId,
      device_id: result.deviceId,
      device_token: token,
    });
  });
}
