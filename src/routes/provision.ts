/**
 * 逆方向ペアリング API（provision → poll → claim）。
 *
 * 【設計思想】
 * 見守られる側は高齢者。操作を極限まで減らすため、ペアリングの方向を逆転する。
 *
 * 旧フロー: ウォッチャーがコード発行 → 高齢者端末で6桁入力 + 名前入力
 * 新フロー: 高齢者はアプリ起動 + 同意タップ → 端末が自動でQR表示
 *           → ウォッチャーが自分のスマホでQR読取 → 名前入力もウォッチャー側
 *
 * provision は clients / devices / events / watch_links を一切触れない。
 * claim されなければ期限切れで自動削除される（orphan デバイスが発生しない）。
 *
 * 旧フロー（pairing-codes / clients/pair）とは完全に独立して共存する。
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueDeviceToken } from '../auth/jwt.js';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { checkClientQuota, createWatchLink, getInitialThreshold } from '../lib/plan.js';

/** provision の TTL（分）。高齢者がQRを表示して家族の到着を待つケースに対応。 */
const PROVISION_TTL_MINUTES = 30;

/** provision のIPレート制限（1時間あたり）。認証なしのため厳しめ。 */
const PROVISION_RATE_LIMIT = { max: 10, timeWindow: '1 hour' as const };

/** provision リクエストスキーマ */
const provisionSchema = z.object({
  platform: z.string().min(1).max(50),
  app_version: z.string().max(50).optional(),
  fcm_token: z.string().max(500).optional(),
  /** 同意バージョン。法務要件: 本人端末から受け取る（spec 7.1）。 */
  consent_version: z.string().min(1).max(50),
});

/** claim リクエストスキーマ */
const claimSchema = z.object({
  /** claim_code（QR読取）または fallback_code（手入力）のどちらか。 */
  code: z.string().min(1).max(200),
  /** ウォッチャーが入力する表示名。高齢者に入力させない。 */
  display_name: z.string().min(1).max(100),
  /**
   * オンボーディングの自己申告（ウォッチャー側で代理回答）。
   * 旧フローの clients/pair と同じ。
   */
  usage_frequency: z.enum(['frequent', 'occasional']).optional(),
});

/**
 * QR用の長いランダム文字列を生成する（URL-safe base64、32バイト = 43文字）。
 * UUID より長く、ブルートフォースは実質不可能。
 */
function generateClaimCode(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * ポーリング認証用の秘密値を生成する。claim_code とは別値。
 * QR が漏れてもポーリングはできないようにするため。
 */
function generateClaimSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 手入力フォールバック用の6桁コードを生成する。
 * 暗号論的に安全な乱数を使う（pairing-codes と同じ理由）。
 */
function generateFallbackCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Authorization ヘッダから claim_secret を抽出する。
 * JWT ではなく plain secret を Bearer 形式で受け取る。
 */
function extractClaimSecret(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1]!;
}

/**
 * 逆方向ペアリングのルートを登録する。
 */
export default async function provisionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/provisions — 端末の自己登録（認証なし・IPレート制限あり）
   *
   * clients / devices / watch_links には一切書き込まない。
   * provisions テーブルにのみ書き込み、claim されなければ期限切れで消える。
   *
   * 201: provision 成功
   * 400: バリデーションエラー
   * 429: レート制限
   */
  app.post(
    '/v1/provisions',
    {
      config: {
        rateLimit: {
          ...PROVISION_RATE_LIMIT,
          // 認証なしのためIPベース固定。keyGenerator を上書きしてグローバル設定の
          // sub ベースのキー生成を無効化する。
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (req, reply) => {
      const parsed = provisionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { platform, app_version, fcm_token, consent_version } = parsed.data;

      const claimCode = generateClaimCode();
      const claimSecret = generateClaimSecret();

      // fallback_code の衝突に備えてリトライ（有効な provision は少数なので稀）
      let fallbackCode: string | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateFallbackCode();
        // 有効期限内かつ未 claim の同じ fallback_code がなければOK
        const existing = await query(
          `SELECT 1 FROM provisions
           WHERE fallback_code = $1 AND expires_at > now() AND claimed_at IS NULL
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
        `INSERT INTO provisions
           (claim_code, fallback_code, claim_secret, platform, app_version,
            fcm_token, consent_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' minutes')::interval)
         RETURNING id`,
        [
          claimCode,
          fallbackCode,
          claimSecret,
          platform,
          app_version ?? null,
          fcm_token ?? null,
          consent_version,
          PROVISION_TTL_MINUTES,
        ],
      );

      return reply.code(201).send({
        provision_id: res.rows[0]!.id,
        claim_code: claimCode,
        fallback_code: fallbackCode,
        claim_secret: claimSecret,
        expires_in_minutes: PROVISION_TTL_MINUTES,
      });
    },
  );

  /**
   * GET /v1/provisions/me — ポーリング（claim_secret で認証）
   *
   * 端末が3〜5秒間隔でポーリングし、claim されたらホーム画面へ遷移する。
   * claim_secret を Authorization: Bearer で送る（JWT ではない平文シークレット）。
   *
   * 200: { claimed: false } または { claimed: true, device_token, client_id }
   * 401: claim_secret が無い/不正
   * 404: provision が存在しない or 期限切れ
   */
  app.get(
    '/v1/provisions/me',
    {
      config: {
        rateLimit: {
          // ポーリング用に少し緩め（3秒間隔 = 1分で20回。余裕を見て30回/分）。
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req) => {
            const secret = extractClaimSecret(req.headers.authorization);
            return secret ?? req.ip;
          },
        },
      },
    },
    async (req, reply) => {
      const secret = extractClaimSecret(req.headers.authorization);
      if (!secret) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'Authorization: Bearer <claim_secret> が必要です',
        });
      }

      const res = await query<{
        id: string;
        claimed_at: Date | null;
        client_id: string | null;
        device_id: string | null;
        expires_at: Date;
      }>(
        `SELECT id, claimed_at, client_id, device_id, expires_at
         FROM provisions
         WHERE claim_secret = $1`,
        [secret],
      );

      const prov = res.rows[0];
      if (!prov) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // 期限切れ
      if (prov.expires_at.getTime() < Date.now() && !prov.claimed_at) {
        return reply.code(404).send({ error: 'expired' });
      }

      if (!prov.claimed_at || !prov.client_id || !prov.device_id) {
        return reply.send({ claimed: false });
      }

      // claim 済み: 正式な device_token を発行して返す
      const deviceToken = issueDeviceToken(app, prov.client_id, prov.device_id);
      return reply.send({
        claimed: true,
        device_token: deviceToken,
        client_id: prov.client_id,
      });
    },
  );

  /**
   * POST /v1/clients/claim — ウォッチャーが provision を自分の見守り対象として登録
   *
   * claim_code（QR読取）または fallback_code（手入力）のどちらでも受理する。
   * client + device + watch_link を1トランザクションで作成する。
   *
   * 201: claim 成功（初回）
   * 400: バリデーションエラー / invalid_code
   * 402: 無料枠超過（ペイウォール誘導）
   * 409: already_claimed
   */
  app.post(
    '/v1/clients/claim',
    { preHandler: app.requireWatcher },
    async (req, reply) => {
      const parsed = claimSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const { code, display_name, usage_frequency } = parsed.data;
      const watcherId = req.watcherId!;

      // 無料枠チェック（pairing-codes と同じロジック。lib/plan.ts に集約済み）
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
        // claim_code または fallback_code で検索（期限内・未 claim）。
        // FOR UPDATE でロック。
        const provRes = await tx.query<{
          id: string;
          platform: string;
          app_version: string | null;
          fcm_token: string | null;
          consent_version: string;
          claimed_at: Date | null;
        }>(
          `SELECT id, platform, app_version, fcm_token, consent_version, claimed_at
           FROM provisions
           WHERE (claim_code = $1 OR fallback_code = $1)
             AND expires_at > now()
           FOR UPDATE`,
          [code],
        );

        const prov = provRes.rows[0];
        if (!prov) return { error: 'invalid_code' as const };
        if (prov.claimed_at) return { error: 'already_claimed' as const };

        // 自己申告 + platform に基づく初期閾値（spec 5.3 + iOS 対応）
        const initialThreshold = getInitialThreshold(prov.platform, usage_frequency);

        // client 作成
        const clientRes = await tx.query<{ id: string }>(
          `INSERT INTO clients (display_name, consent_version, consent_at, threshold_minutes,
                                last_alive_event_at, status, status_changed_at)
           VALUES ($1, $2, now(), $3, now(), 'ALIVE', now())
           RETURNING id`,
          [display_name, prov.consent_version, initialThreshold],
        );
        const clientId = clientRes.rows[0]!.id;

        // watch_link 作成
        const billable = await createWatchLink(tx, watcherId, clientId);

        // device 作成
        const deviceRes = await tx.query<{ id: string }>(
          `INSERT INTO devices (client_id, platform, fcm_token, app_version, last_seen_at)
           VALUES ($1, $2, $3, $4, now())
           RETURNING id`,
          [clientId, prov.platform, prov.fcm_token ?? null, prov.app_version ?? null],
        );
        const deviceId = deviceRes.rows[0]!.id;

        // provision を claimed にする
        await tx.query(
          `UPDATE provisions
           SET claimed_at = now(), claimed_by = $1, client_id = $2, device_id = $3
           WHERE id = $4`,
          [watcherId, clientId, deviceId, prov.id],
        );

        // 監査ログ（法務要件の証跡）
        await audit(
          clientId,
          'client_claimed',
          {
            watcher_id: watcherId,
            provision_id: prov.id,
            consent_version: prov.consent_version,
            platform: prov.platform,
            app_version: prov.app_version ?? null,
            billable,
            initial_threshold_minutes: initialThreshold,
          },
          tx,
        );

        return { clientId };
      });

      if ('error' in result) {
        if (result.error === 'already_claimed') {
          return reply.code(409).send({
            error: 'already_claimed',
            message: 'このコードは既に使用されています',
          });
        }
        return reply.code(400).send({
          error: 'invalid_code',
          message: 'コードが無効か、有効期限が切れています',
        });
      }

      return reply.code(201).send({ client_id: result.clientId });
    },
  );
}
