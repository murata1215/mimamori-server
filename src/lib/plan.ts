/**
 * プラン・課金枠の判定（spec 5 課金設計）。
 *
 * 【なぜ独立モジュールなのか】
 * 「無料枠は2人まで、3人目から課金」の判定が、ペアリング経路と
 * センサーのみクライアント作成経路（Phase 2）の2箇所に必要になった。
 * コピーすると片方だけ無料枠が無制限、という課金漏れが起きるため1箇所に置く。
 */
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { query } from '../db/pool.js';

/** 無料枠の見守り対象数。3人目から課金（spec 5）。 */
export const FREE_TIER_LIMIT = 2;

/**
 * クライアント新規作成時の初期閾値（分）を決定する。
 *
 * 【iOS 対応】
 * iOS はバックグラウンド実行が OS 任せで 15分周期ハートビートが保証されない。
 * screen_on_count / had_app_usage 相当の API もないため、生存シグナル間隔が
 * Android より長くなる。初期閾値を長めに設定して誤報を防ぐ。
 * 学習エンジンが実シグナル間隔の p99 を学習すれば自然と適切な値に収束する。
 *
 * @param platform - 端末の platform（'ios', 'android' 等）
 * @param usageFrequency - オンボーディングの自己申告（'frequent' | 'occasional' | undefined）
 * @returns 初期閾値（分）
 */
export function getInitialThreshold(
  platform: string,
  usageFrequency?: string,
): number {
  if (usageFrequency === 'frequent') {
    return config.FREQUENT_THRESHOLD_MINUTES;
  }
  if (platform.toLowerCase() === 'ios') {
    return config.DEFAULT_THRESHOLD_MINUTES_IOS;
  }
  return config.DEFAULT_THRESHOLD_MINUTES;
}

/** 見守り枠の判定結果 */
export interface QuotaCheck {
  /** 現在の見守り対象数 */
  currentCount: number;
  /** ウォッチャーのプラン */
  plan: string;
  /** 新規追加が無料枠を超えるか（= 402 を返すべきか） */
  exceedsFreeTier: boolean;
}

/**
 * ウォッチャーが新たに見守り対象を追加できるかを判定する。
 *
 * @param watcherId - ウォッチャーID
 * @returns 判定結果
 */
export async function checkClientQuota(watcherId: string): Promise<QuotaCheck> {
  const [countRes, planRes] = await Promise.all([
    query<{ count: number }>('SELECT COUNT(*)::int AS count FROM watch_links WHERE watcher_id = $1', [
      watcherId,
    ]),
    query<{ plan: string }>('SELECT plan FROM watchers WHERE id = $1', [watcherId]),
  ]);

  const currentCount = countRes.rows[0]?.count ?? 0;
  const plan = planRes.rows[0]?.plan ?? 'free';

  // ownerプランは人数無制限（従量課金）。無料プランのみ2人で頭打ち。
  return {
    currentCount,
    plan,
    exceedsFreeTier: plan === 'free' && currentCount >= FREE_TIER_LIMIT,
  };
}

/**
 * watch_links を作成する。
 *
 * billable は「そのwatcherにとって3人目以降か」を作成時に確定させる。
 * 後から2人目が解除されても既存linkのbillableは動かさない
 * （課金の予測可能性のため。ユーザーから見て請求額が勝手に変わらない）。
 *
 * @param tx - トランザクション
 * @param watcherId - ウォッチャーID
 * @param clientId - クライアントID
 * @returns 課金対象として作成されたか
 */
export async function createWatchLink(
  tx: PoolClient,
  watcherId: string,
  clientId: string,
): Promise<boolean> {
  const countRes = await tx.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM watch_links WHERE watcher_id = $1',
    [watcherId],
  );
  const existingCount = countRes.rows[0]?.count ?? 0;
  const billable = existingCount >= FREE_TIER_LIMIT;

  await tx.query(
    `INSERT INTO watch_links (watcher_id, client_id, role, billable)
     VALUES ($1, $2, 'primary', $3)`,
    [watcherId, clientId, billable],
  );

  return billable;
}
