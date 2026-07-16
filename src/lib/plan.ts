/**
 * プラン・課金枠の判定（spec 5 課金設計）。
 *
 * 【なぜ独立モジュールなのか】
 * 「無料枠は2人まで、3人目から課金」の判定が、ペアリング経路と
 * センサーのみクライアント作成経路（Phase 2）の2箇所に必要になった。
 * コピーすると片方だけ無料枠が無制限、という課金漏れが起きるため1箇所に置く。
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.js';

/** 無料枠の見守り対象数。3人目から課金（spec 5）。 */
export const FREE_TIER_LIMIT = 2;

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
