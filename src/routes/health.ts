/**
 * ヘルスチェック（サービス自身のデッドマンスイッチ）。
 *
 * 【必須要件】(spec 7.3 / 7)
 * 見守りサービス自身が沈黙することは許されない。
 * このエンドポイントを外部監視（UptimeRobot等）から1分間隔で叩き、
 * 判定ジョブが10分以上止まっていたら503を返して管理者へエスカレーションする。
 *
 * つまりこのエンドポイントは「サーバーが応答するか」ではなく
 * 「見守りが機能しているか」を返す。プロセスが生きていても判定ジョブが
 * 死んでいれば見守りは止まっているため、200を返してはならない。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pingDb, query } from '../db/pool.js';
import { EVALUATOR_JOB_NAME } from '../engine/evaluator.js';

/**
 * ルートURL用の案内ページを読み込む。
 *
 * ブラウザで直接開いた人向けの静的な1ページのみのため、
 * @fastify/static は導入せず起動時に一度だけ読み込む。
 * ファイルが無い環境でも起動を止めない（案内ページは見守り機能に無関係）。
 */
function loadLandingPage(): string {
  try {
    return readFileSync(resolve(process.cwd(), 'placeholder/index.html'), 'utf8');
  } catch {
    return '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>mimamori-server</title></head>' +
      '<body><h1>mimamori-server</h1><p>見守りサービス API サーバーです。ブラウザから利用する画面はありません。</p></body></html>';
  }
}

/**
 * ヘルスチェックルートを登録する。
 *
 * @param app - fastify インスタンス
 */
export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /healthz — 外形監視用
   *
   * 200: DB接続OK かつ 判定ジョブが規定時間内に実行されている
   * 503: 上記のいずれかが満たされない
   */
  app.get('/healthz', async (_req, reply) => {
    const checks: Record<string, unknown> = {};

    // --- DB接続 ---
    const dbOk = await pingDb();
    checks.database = dbOk ? 'ok' : 'unreachable';

    if (!dbOk) {
      // DBが死んでいれば判定ジョブも動けない。即座に異常を返す。
      return reply.code(503).send({ status: 'unhealthy', checks });
    }

    // --- 判定ジョブの最終実行時刻 ---
    const res = await query<{ last_run_at: Date; last_status: string }>(
      'SELECT last_run_at, last_status FROM job_runs WHERE job_name = $1',
      [EVALUATOR_JOB_NAME],
    );
    const job = res.rows[0];

    if (!job) {
      // 一度も実行されていない = 起動直後。
      // 起動直後に503を返し続けると監視が誤報するため、
      // 起動から猶予時間内は 'starting' として200を返す。
      const uptimeMinutes = process.uptime() / 60;
      if (uptimeMinutes < config.HEALTH_JOB_STALL_MINUTES) {
        checks.evaluator = 'starting';
        return reply.send({ status: 'starting', checks });
      }
      checks.evaluator = 'never_ran';
      return reply.code(503).send({ status: 'unhealthy', checks });
    }

    const staleMinutes = (Date.now() - job.last_run_at.getTime()) / 60_000;
    checks.evaluator = {
      last_run_at: job.last_run_at.toISOString(),
      stale_minutes: Number(staleMinutes.toFixed(1)),
      last_status: job.last_status,
    };

    // 判定ジョブが規定時間止まっている = 見守りが止まっている
    if (staleMinutes > config.HEALTH_JOB_STALL_MINUTES) {
      return reply.code(503).send({
        status: 'unhealthy',
        reason: 'evaluator_stalled',
        message: `判定ジョブが${staleMinutes.toFixed(1)}分停止しています`,
        checks,
      });
    }

    return reply.send({ status: 'ok', checks });
  });

  /**
   * GET /livez — プロセス生存確認のみ（systemd / コンテナ用）
   *
   * /healthz と違い、判定ジョブの状態は見ない。
   * これを外形監視に使ってはならない（判定ジョブが死んでも200を返すため）。
   */
  app.get('/livez', async (_req, reply) => reply.send({ status: 'ok' }));

  /**
   * GET / — ブラウザで直接開いた人向けの案内ページ
   *
   * 本サーバーは API 専用だが、ルートURLで JSON の not_found を返すと
   * 「壊れている」と誤解されるため、静的な案内 HTML を返す。
   * API の挙動・エラー形式には一切影響しない。
   */
  const landingPage = loadLandingPage();
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(landingPage),
  );

  /** GET /favicon.ico — ブラウザアクセス時の 404 ログノイズ防止 */
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
}
