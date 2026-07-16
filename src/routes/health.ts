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
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pingDb, query } from '../db/pool.js';
import { EVALUATOR_JOB_NAME } from '../engine/evaluator.js';

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
}
