/**
 * 閾値学習エンジン（原則3「閾値は生活サイクルから自動学習」）。
 *
 * 固定の「◯時間ルール」は誤報か検知漏れのどちらかを生む。
 * 曜日 × 時間帯（4h刻み）ごとの生存イベント間隔分布を学習し、
 * クライアントごとに閾値を自動算出する。
 *
 * 誤報率の低さがこのプロダクトの生命線であり、最大の差別化要素。
 * したがってこのモジュールの挙動は KPI（誤報率5%未満）に直結する。
 */
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { SERVICE_TIMEZONE, localPartsOf } from '../lib/timezone.js';

/** 時間帯バケットの幅（時間）。4h刻みで 0-5 の6バケット。 */
export const HOUR_BUCKET_SIZE = 4;

/**
 * 時刻から時間帯バケット番号を求める。
 *
 * 【重要】必ず基準TZ（Asia/Tokyo）で判定する。学習側のSQLも同じTZを使うこと。
 * 両者がズレるとバケットが食い違い、誤った閾値が適用される。
 *
 * @param date - 対象時刻
 * @returns 0-5 のバケット番号（0-3時台=0, 4-7時台=1, ... 20-23時台=5）
 */
export function hourBucketOf(date: Date): number {
  return Math.floor(localPartsOf(date).hour / HOUR_BUCKET_SIZE);
}

/**
 * 時刻から曜日を求める（基準TZ基準）。
 *
 * @param date - 対象時刻
 * @returns 0(日) - 6(土)
 */
export function dowOf(date: Date): number {
  return localPartsOf(date).dow;
}

/**
 * 閾値を下限・上限でクランプする。
 *
 * 学習の暴走防止。サンプルが偏ると p99 が異常値を取りうるため、
 * 下限6時間（短すぎる＝誤報の嵐）・上限24時間（長すぎる＝検知漏れ）で挟む。
 *
 * @param minutes - クランプ前の閾値（分）
 * @returns クランプ後の閾値（分）
 */
export function clampThreshold(minutes: number): number {
  return Math.min(
    config.MAX_THRESHOLD_MINUTES,
    Math.max(config.MIN_THRESHOLD_MINUTES, Math.round(minutes)),
  );
}

/** 有効閾値の算出結果 */
export interface EffectiveThreshold {
  /** 適用する閾値（分） */
  minutes: number;
  /** 由来。'learned' = 学習値、'default' = デフォルト値へのフォールバック */
  mode: 'learned' | 'default';
  /** 学習値を使った場合のサンプル数（デバッグ・監査用） */
  sampleCount?: number;
}

/**
 * 現在時刻におけるクライアントの有効閾値を求める。
 *
 * 判定ジョブが毎分・全クライアント分呼ぶため、DBアクセスは1クエリに抑える。
 *
 * フォールバックの階段:
 *   1. 現在のバケットに十分なサンプル（>= MIN_SAMPLE_COUNT）がある → 学習値
 *   2. サンプル不足 or バケット未学習 → clients.threshold_minutes（デフォルト or 自己申告初期値）
 *
 * @param clientId - クライアントID
 * @param fallbackMinutes - 学習値が使えない場合の閾値（clients.threshold_minutes）
 * @param now - 判定基準時刻
 * @returns 有効閾値
 */
export async function getEffectiveThreshold(
  clientId: string,
  fallbackMinutes: number,
  now: Date,
): Promise<EffectiveThreshold> {
  const dow = dowOf(now);
  const bucket = hourBucketOf(now);

  const res = await query<{ p99_gap_minutes: number; sample_count: number }>(
    `SELECT p99_gap_minutes, sample_count
       FROM thresholds
      WHERE client_id = $1 AND dow = $2 AND hour_bucket = $3`,
    [clientId, dow, bucket],
  );

  const row = res.rows[0];
  // サンプル不足バケットはデフォルトへフォールバック（spec 5.3）
  if (!row || row.sample_count < config.MIN_SAMPLE_COUNT) {
    return { minutes: clampThreshold(fallbackMinutes), mode: 'default' };
  }

  return {
    minutes: clampThreshold(row.p99_gap_minutes + config.THRESHOLD_MARGIN_MINUTES),
    mode: 'learned',
    sampleCount: row.sample_count,
  };
}

/**
 * 1クライアントの閾値を学習する。
 *
 * 直近 LEARNING_WINDOW_WEEKS 週間の生存イベントから、連続するイベントの間隔（gap）を
 * 求め、gap の始点が属する曜日×時間帯バケットごとに p99 を計算する。
 *
 * 【設計判断】gap を「始点のバケット」に帰属させる理由:
 *   深夜0時に操作して朝8時に操作した場合、この8時間のgapは「深夜バケット」に属する。
 *   これにより就寝中の長いギャップが深夜バケットに正しく学習され、
 *   日中バケットの閾値が不必要に伸びるのを防ぐ。
 *   （spec 5.3「深夜バケットは自然にギャップが大きく学習されるため特別処理は不要」）
 *
 * @param clientId - クライアントID
 * @returns 学習したバケット数
 */
export async function learnThresholdsForClient(clientId: string): Promise<number> {
  // 生存イベントの定義に合致する行だけを対象にする（後述 isAliveEventSql と揃える）。
  //
  // window関数 lead() で次イベントとの間隔を求め、gap始点のバケットへ集約する。
  // percentile_cont(0.99) で p99 を取る（連続分布の補間値。サンプルが少ない時に
  // percentile_disc より安定する）。
  const sql = `
    WITH alive_events AS (
      SELECT occurred_at
        FROM events
       WHERE client_id = $1
         AND occurred_at >= now() - ($2 || ' weeks')::interval
         AND (
              event_type IN ('activity', 'confirm_alive')
           OR (
                event_type = 'heartbeat'
                AND (
                     COALESCE((meta->>'screen_on_count')::int, 0) > 0
                  OR COALESCE((meta->>'had_app_usage')::boolean, false) = true
                )
              )
         )
       ORDER BY occurred_at
    ),
    gaps AS (
      SELECT
        occurred_at,
        EXTRACT(EPOCH FROM (lead(occurred_at) OVER (ORDER BY occurred_at) - occurred_at)) / 60
          AS gap_minutes
        FROM alive_events
    ),
    bucketed AS (
      -- 【重要】必ず基準TZへ変換してから曜日・時を取り出す。
      -- DBセッションTZ任せにすると hourBucketOf()（JS側・Asia/Tokyo固定）と
      -- バケットが食い違い、学習値が誤ったバケットに適用される。
      SELECT
        EXTRACT(DOW  FROM occurred_at AT TIME ZONE $4)::smallint AS dow,
        (EXTRACT(HOUR FROM occurred_at AT TIME ZONE $4)::int / $3)::smallint AS hour_bucket,
        gap_minutes
        FROM gaps
       WHERE gap_minutes IS NOT NULL
    )
    INSERT INTO thresholds (client_id, dow, hour_bucket, p99_gap_minutes, sample_count, updated_at)
    SELECT
      $1,
      dow,
      hour_bucket,
      GREATEST(1, CEIL(percentile_cont(0.99) WITHIN GROUP (ORDER BY gap_minutes))::int),
      COUNT(*)::int,
      now()
      FROM bucketed
     GROUP BY dow, hour_bucket
    ON CONFLICT (client_id, dow, hour_bucket) DO UPDATE
      SET p99_gap_minutes = EXCLUDED.p99_gap_minutes,
          sample_count    = EXCLUDED.sample_count,
          updated_at      = EXCLUDED.updated_at
  `;

  const res = await query(sql, [
    clientId,
    config.LEARNING_WINDOW_WEEKS,
    HOUR_BUCKET_SIZE,
    SERVICE_TIMEZONE,
  ]);
  return res.rowCount ?? 0;
}

/**
 * 学習対象となるクライアントを取得する。
 *
 * コールドスタート期間（登録から COLD_START_DAYS 日）は学習しない。
 * サンプルが少なすぎて誤った閾値を学習するリスクがあるため、
 * その間はデフォルト閾値で運用する（spec 5.3）。
 *
 * @returns 学習対象のクライアントID一覧
 */
export async function getLearnableClients(): Promise<string[]> {
  const res = await query<{ id: string }>(
    `SELECT id FROM clients
      WHERE created_at <= now() - ($1 || ' days')::interval`,
    [config.COLD_START_DAYS],
  );
  return res.rows.map((r) => r.id);
}

/**
 * 全クライアントの閾値を学習する日次バッチ。
 *
 * 学習後、クライアントの threshold_mode を 'learned' に更新する
 * （どのモードで運用中かをウォッチャー向けではなく運用者が把握するため）。
 *
 * @returns 学習したクライアント数
 */
export async function runThresholdLearning(): Promise<number> {
  const clientIds = await getLearnableClients();
  let learned = 0;

  for (const clientId of clientIds) {
    try {
      const buckets = await learnThresholdsForClient(clientId);

      // 十分なサンプルを持つバケットが1つでもあれば learned モードとする。
      // 全バケットがサンプル不足なら default のまま（getEffectiveThreshold が
      // バケット単位でフォールバックするため、モードは表示上の意味しか持たない）。
      const usable = await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM thresholds
          WHERE client_id = $1 AND sample_count >= $2`,
        [clientId, config.MIN_SAMPLE_COUNT],
      );
      const usableCount = usable.rows[0]?.count ?? 0;

      await query(
        `UPDATE clients SET threshold_mode = $2 WHERE id = $1`,
        [clientId, usableCount > 0 ? 'learned' : 'default'],
      );

      await audit(clientId, 'threshold_learned', {
        buckets_written: buckets,
        usable_buckets: usableCount,
      });
      learned++;
    } catch (err) {
      // 1クライアントの学習失敗が全体のバッチを止めてはならない
      console.error(`[thresholds] クライアント ${clientId} の学習に失敗:`, err);
    }
  }

  return learned;
}
