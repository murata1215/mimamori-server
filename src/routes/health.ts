/**
 * ヘルスチェック（サービス自身のデッドマンスイッチ）と公開ステータスページ。
 *
 * 【必須要件】(spec 7.3 / 7)
 * 見守りサービス自身が沈黙することは許されない。
 * /healthz を外部監視（UptimeRobot等）から1分間隔で叩き、
 * 判定ジョブが10分以上止まっていたら503を返して管理者へエスカレーションする。
 *
 * つまり /healthz は「サーバーが応答するか」ではなく
 * 「見守りが機能しているか」を返す。プロセスが生きていても判定ジョブが
 * 死んでいれば見守りは止まっているため、200を返してはならない。
 *
 * 【公開ステータス】GET /statusz / GET /
 * ログイン不要で稼働状態と利用者数（集計値のみ）を返す。
 * 個人名・ID・個別ステータス・ステータス別内訳・時刻情報は絶対に出さない
 * （絶対ルール2/3。集計以外を公開すると特定物件の異常を部外者に推測される）。
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

/** ヘルス判定の結果。/healthz と /statusz で共有する。 */
interface HealthResult {
  /** 見守りが機能しているか（DB疎通 かつ 判定ジョブが規定時間内に実行）。 */
  healthy: boolean;
  /** 監視用の詳細（/healthz でのみ返す。/statusz には出さない）。 */
  checks: Record<string, unknown>;
  /** 状態のラベル: 'ok' | 'starting' | 'unhealthy'。 */
  state: 'ok' | 'starting' | 'unhealthy';
}

/**
 * 「見守りが機能しているか」を判定する。
 *
 * DBが死んでいれば判定ジョブも動けないため即 unhealthy。
 * 判定ジョブが規定時間止まっていれば unhealthy。
 * 起動直後で一度も実行されていない場合は猶予時間内なら starting（正常扱い）。
 */
async function evaluateHealth(): Promise<HealthResult> {
  const checks: Record<string, unknown> = {};

  const dbOk = await pingDb();
  checks.database = dbOk ? 'ok' : 'unreachable';
  if (!dbOk) {
    return { healthy: false, checks, state: 'unhealthy' };
  }

  const res = await query<{ last_run_at: Date; last_status: string }>(
    'SELECT last_run_at, last_status FROM job_runs WHERE job_name = $1',
    [EVALUATOR_JOB_NAME],
  );
  const job = res.rows[0];

  if (!job) {
    // 一度も実行されていない = 起動直後。猶予時間内は starting（正常）。
    const uptimeMinutes = process.uptime() / 60;
    if (uptimeMinutes < config.HEALTH_JOB_STALL_MINUTES) {
      checks.evaluator = 'starting';
      return { healthy: true, checks, state: 'starting' };
    }
    checks.evaluator = 'never_ran';
    return { healthy: false, checks, state: 'unhealthy' };
  }

  const staleMinutes = (Date.now() - job.last_run_at.getTime()) / 60_000;
  checks.evaluator = {
    last_run_at: job.last_run_at.toISOString(),
    stale_minutes: Number(staleMinutes.toFixed(1)),
    last_status: job.last_status,
  };

  if (staleMinutes > config.HEALTH_JOB_STALL_MINUTES) {
    checks.evaluator_stalled = true;
    return { healthy: false, checks, state: 'unhealthy' };
  }

  return { healthy: true, checks, state: 'ok' };
}

/** 公開ステータスの集計値。個人を特定しうる情報は一切含めない。 */
interface PublicStats {
  service: 'mimamori-server';
  /** 'ok' | 'starting' | 'unhealthy'。 */
  status: string;
  /** みまもりユーザー数。 */
  watchers: number;
  /** みまもられるユーザー数。 */
  clients: number;
  /** ユニークユーザー数（watchers + clients を別人格として合算）。 */
  unique_users: number;
  /** 見守り接続（ペア）数。 */
  watch_links: number;
  /** 登録端末数。 */
  devices: number;
  /** 集計時刻（ISO8601）。 */
  generated_at: string;
}

/** /statusz のインメモリキャッシュ（ログイン不要で誰でも叩けるためDBを保護する）。 */
const STATS_CACHE_TTL_MS = 60_000;
let statsCache: { value: PublicStats; expiresAt: number } | null = null;

/**
 * 公開ステータスを集計する（60秒キャッシュ）。
 *
 * COUNT は 1 クエリにまとめ、キャッシュで連打からDBを守る。
 * 返すのは集計値のみ。ステータス別内訳・名前・ID・時刻情報は含めない。
 */
async function collectPublicStats(): Promise<PublicStats> {
  const now = Date.now();
  if (statsCache && statsCache.expiresAt > now) {
    return statsCache.value;
  }

  const health = await evaluateHealth();

  // DBが死んでいる場合はカウントできない。稼働状態のみ返す（数値は0）。
  let watchers = 0;
  let clients = 0;
  let watchLinks = 0;
  let devices = 0;
  if (health.state !== 'unhealthy' || health.checks.database === 'ok') {
    const res = await query<{
      watchers: number;
      clients: number;
      watch_links: number;
      devices: number;
    }>(
      `SELECT
         (SELECT count(*) FROM watchers)     AS watchers,
         (SELECT count(*) FROM clients)      AS clients,
         (SELECT count(*) FROM watch_links)  AS watch_links,
         (SELECT count(*) FROM devices)      AS devices`,
    );
    const row = res.rows[0];
    if (row) {
      watchers = Number(row.watchers);
      clients = Number(row.clients);
      watchLinks = Number(row.watch_links);
      devices = Number(row.devices);
    }
  }

  const value: PublicStats = {
    service: 'mimamori-server',
    status: health.state,
    watchers,
    clients,
    unique_users: watchers + clients,
    watch_links: watchLinks,
    devices,
    generated_at: new Date(now).toISOString(),
  };

  statsCache = { value, expiresAt: now + STATS_CACHE_TTL_MS };
  return value;
}

/**
 * ヘルスチェック・公開ステータスのルートを登録する。
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
    const health = await evaluateHealth();
    if (!health.healthy) {
      return reply
        .code(503)
        .send({ status: 'unhealthy', checks: health.checks });
    }
    return reply.send({ status: health.state, checks: health.checks });
  });

  /**
   * GET /livez — プロセス生存確認のみ（systemd / コンテナ用）
   *
   * /healthz と違い、判定ジョブの状態は見ない。
   * これを外形監視に使ってはならない（判定ジョブが死んでも200を返すため）。
   */
  app.get('/livez', async (_req, reply) => reply.send({ status: 'ok' }));

  /**
   * GET /statusz — 公開ステータス（ログイン不要）
   *
   * 稼働状態と利用者数の集計値のみを返す。
   * 個人名・ID・個別/内訳ステータス・時刻情報は絶対に含めない（絶対ルール2/3）。
   * 常に 200 で返す（外形監視は /healthz を使う。ここは表示用）。
   */
  app.get('/statusz', async (_req, reply) => {
    const stats = await collectPublicStats();
    return reply.send(stats);
  });

  /**
   * GET / — ブラウザで直接開いた人向けの公開ステータスページ
   *
   * 静的 HTML を返す。ページ内の JS が /statusz を fetch して数値を埋める。
   * バックエンド停止時は Caddy が同じ HTML をフォールバック表示するため、
   * fetch 失敗時は「停止中」を表示できるよう HTML 側で分岐している。
   * API の挙動・エラー形式には一切影響しない。
   */
  const landingPage = loadLandingPage();
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(landingPage),
  );

  /** GET /favicon.ico — ブラウザアクセス時の 404 ログノイズ防止 */
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
}
