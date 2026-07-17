/**
 * インプロセス・ジョブスケジューラ（node-cron）。
 *
 * Phase 1 はワーカーを分離しない（spec 2）。
 *
 * 【ジョブ一覧】
 * - evaluator     : 毎分。判定ジョブ。これが止まる = 見守りが止まる。
 * - threshold     : 日次。閾値学習。
 * - sos_purge     : 日次。位置情報の物理削除（30日経過分）。
 * - partition     : 日次。events の月次パーティション先行作成。
 * - kpi_summary   : 日次。Phase 1 の合否判定データを集計。
 * - provision_cleanup : 毎時。期限切れ provision の物理削除。
 * - invite_cleanup    : 毎時。期限切れ invite_codes の物理削除。
 * - stamp_cleanup     : 日次。90日経過スタンプの物理削除。
 *
 * 【多重実行の防止】
 * 判定ジョブが1分以内に終わらない場合、次の実行が重なる。
 * 重なると同じクライアントに二重で通知が飛ぶため、実行中フラグでガードする。
 */
import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { EVALUATOR_JOB_NAME, runEvaluation } from '../engine/evaluator.js';
import { runThresholdLearning } from '../engine/thresholds.js';
import { audit } from '../lib/audit.js';
import { notifyServiceOutage } from '../notify/dispatcher.js';
import { SERVICE_TIMEZONE } from '../lib/timezone.js';

/** 起動中のcronタスク（シャットダウン時に停止するため保持） */
const tasks: ScheduledTask[] = [];

/**
 * 判定ジョブの実行中フラグ。
 * 前回の実行が終わる前に次が始まるのを防ぐ。
 */
let evaluatorRunning = false;

/**
 * 判定ジョブを1回実行する（多重実行ガード付き）。
 */
async function tickEvaluator(): Promise<void> {
  if (evaluatorRunning) {
    console.warn('[scheduler] 前回の判定ジョブがまだ実行中です。今回はスキップします');
    return;
  }
  evaluatorRunning = true;
  const started = Date.now();
  try {
    const result = await runEvaluation();
    const elapsed = Date.now() - started;

    // 判定に時間がかかりすぎている = クライアント数に対して処理が追いついていない。
    // Phase 1 では単純にログ警告。Phase 2 以降でワーカー分離の判断材料にする。
    if (elapsed > 30_000) {
      console.warn(
        `[scheduler] 判定ジョブに${elapsed}msかかりました（対象${result.evaluated}件）。` +
          'ワーカー分離を検討してください',
      );
    }

    if (result.transitions > 0 || result.errors > 0) {
      console.log(
        `[scheduler] 判定完了: 対象${result.evaluated}件 遷移${result.transitions}件 ` +
          `通知${result.notifications}件 エラー${result.errors}件 (${elapsed}ms)`,
      );
    }
  } catch (err) {
    // ジョブ全体の失敗。job_runs が更新されないので /healthz が異常を検知する。
    console.error('[scheduler] 判定ジョブが失敗しました:', err);
  } finally {
    evaluatorRunning = false;
  }
}

/**
 * サービス停止を検知し、必要ならウォッチャーへ正直に通知する。
 *
 * 「サーバー停止が閾値超過時間に及んだ場合、復旧時に『監視が◯時間停止していました』を
 * 全ウォッチャーへ正直に通知する（信頼の担保。黙って再開しない）」(spec 7)。
 *
 * 起動時に一度だけ呼ぶ。前回の判定ジョブ実行時刻からの空白を停止時間とみなす。
 */
async function detectAndReportOutage(): Promise<void> {
  const res = await query<{ last_run_at: Date }>(
    'SELECT last_run_at FROM job_runs WHERE job_name = $1',
    [EVALUATOR_JOB_NAME],
  );
  const lastRun = res.rows[0]?.last_run_at;

  // 初回起動（履歴なし）は停止ではない
  if (!lastRun) return;

  const gapMinutes = Math.round((Date.now() - lastRun.getTime()) / 60_000);

  // 判定ジョブは毎分動くため、数分の空白は再起動やデプロイの範囲。
  // 通知の閾値は「最小閾値（デフォルト6時間）」ではなく、
  // 実務的に意味のある30分とする。
  // これ未満の停止でウォッチャーへ通知すると、デプロイのたびに
  // 全員へ通知が飛んで狼少年化する。
  const NOTIFY_THRESHOLD_MINUTES = 30;

  if (gapMinutes < NOTIFY_THRESHOLD_MINUTES) {
    if (gapMinutes > 5) {
      console.log(`[scheduler] ${gapMinutes}分の空白を検知しましたが、通知閾値未満です`);
    }
    return;
  }

  console.warn(`[scheduler] サービスが${gapMinutes}分停止していました。ウォッチャーへ通知します`);

  await query('INSERT INTO service_outages (gap_minutes, notified_at) VALUES ($1, now())', [
    gapMinutes,
  ]);

  await notifyServiceOutage(gapMinutes).catch((err) => {
    console.error('[scheduler] 停止通知に失敗しました:', err);
  });
}

/**
 * SOSの位置情報を物理削除する（日次）。
 *
 * 【プライバシー要件】(spec 6)
 * purge_after（fired_at + 30日）を過ぎた位置情報は物理削除する。
 * 行ごと削除するのではなく、位置カラムのみ NULL にする選択肢もあるが、
 * spec は「物理削除」を指定しているため行を削除する。
 * 発報の事実自体は audit_log に残るため、証跡は失われない。
 *
 * @returns 削除件数
 */
async function purgeSosLocations(): Promise<number> {
  const res = await query('DELETE FROM sos_incidents WHERE purge_after <= now()');
  const deleted = res.rowCount ?? 0;

  if (deleted > 0) {
    // 削除した事実は監査に残す（位置そのものは残さない）
    await audit(null, 'sos_purged', { deleted_count: deleted });
    console.log(`[scheduler] SOS位置情報を${deleted}件物理削除しました`);
  }

  return deleted;
}

/**
 * Phase 1 の合否判定KPIを集計する（日次）。
 *
 * - ハートビート生存率: 24h以内に到達した端末の割合
 * - 誤報率: ALERT のうち「無事だった」でクローズされた割合
 * - 本人確認解除率: CONFIRMING → confirm_alive で復帰した割合
 *
 * 現状はログ出力のみ。
 * TODO: DevRelay の通知基盤経由で管理者へ日次サマリを送る（spec 9）。
 */
async function summarizeKpi(): Promise<void> {
  const heartbeat = await query<{ total: number; alive: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE last_seen_at >= now() - interval '24 hours')::int AS alive
       FROM devices`,
  );

  const falseAlarm = await query<{ total: number; false_alarms: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE detail->>'false_alarm' = 'true')::int AS false_alarms
       FROM audit_log
      WHERE event = 'status_change'
        AND detail->>'reason' IN ('watcher_resolved_was_safe', 'watcher_confirmed_real')
        AND created_at >= now() - interval '30 days'`,
  );

  const confirming = await query<{ entered: number; recovered: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE detail->>'to' = 'CONFIRMING')::int AS entered,
       COUNT(*) FILTER (WHERE detail->>'reason' = 'alive_event_received'
                          AND detail->>'from' = 'CONFIRMING')::int AS recovered
       FROM audit_log
      WHERE event = 'status_change'
        AND created_at >= now() - interval '30 days'`,
  );

  const hb = heartbeat.rows[0]!;
  const fa = falseAlarm.rows[0]!;
  const cf = confirming.rows[0]!;

  const pct = (num: number, den: number): string =>
    den === 0 ? 'N/A' : `${((num / den) * 100).toFixed(1)}%`;

  const summary = {
    // KPI目標: 99%以上
    heartbeat_alive_rate: pct(hb.alive, hb.total),
    heartbeat_devices: hb.total,
    // KPI目標: 5%未満
    false_alarm_rate: pct(fa.false_alarms, fa.total),
    alerts_resolved: fa.total,
    // KPI目標: 90%以上
    confirming_recovery_rate: pct(cf.recovered, cf.entered),
    confirming_entered: cf.entered,
  };

  console.log('[kpi] 日次サマリ:', JSON.stringify(summary));
  await audit(null, 'threshold_learned', { kind: 'kpi_daily_summary', ...summary });
}

/**
 * 全ジョブを起動する。
 *
 * cron のタイムゾーンは明示的に指定する。
 * 指定しないとサーバーのTZに依存し、「日次バッチが深夜3時に走るはず」が
 * 環境によってズレる。
 */
export async function startScheduler(): Promise<void> {
  // --- 起動時: サービス停止の検知と通知 ---
  await detectAndReportOutage().catch((err) => {
    console.error('[scheduler] 停止検知に失敗しました:', err);
  });

  // --- 判定ジョブ: 毎分 ---
  tasks.push(
    cron.schedule('* * * * *', tickEvaluator, { timezone: SERVICE_TIMEZONE }),
  );

  // --- 閾値学習: 毎日 深夜3時 ---
  // 利用の少ない時間帯を選ぶ。学習は重い処理のため。
  tasks.push(
    cron.schedule(
      '0 3 * * *',
      async () => {
        try {
          const count = await runThresholdLearning();
          console.log(`[scheduler] 閾値学習が完了しました: ${count}件`);
        } catch (err) {
          console.error('[scheduler] 閾値学習に失敗しました:', err);
        }
      },
      { timezone: SERVICE_TIMEZONE },
    ),
  );

  // --- SOS位置情報のpurge: 毎日 深夜4時 ---
  tasks.push(
    cron.schedule(
      '0 4 * * *',
      async () => {
        try {
          await purgeSosLocations();
        } catch (err) {
          console.error('[scheduler] SOS位置情報の削除に失敗しました:', err);
        }
      },
      { timezone: SERVICE_TIMEZONE },
    ),
  );

  // --- パーティション先行作成: 毎日 深夜2時 ---
  // これが失敗すると翌月のイベントがDEFAULTパーティションへ流れる。
  // 即座に壊れはしないが、放置すると性能が劣化する。
  tasks.push(
    cron.schedule(
      '0 2 * * *',
      async () => {
        try {
          await query('SELECT ensure_event_partitions()');
        } catch (err) {
          console.error('[scheduler] パーティション作成に失敗しました:', err);
        }
      },
      { timezone: SERVICE_TIMEZONE },
    ),
  );

  // --- KPI集計: 毎日 朝9時 ---
  tasks.push(
    cron.schedule(
      '0 9 * * *',
      async () => {
        try {
          await summarizeKpi();
        } catch (err) {
          console.error('[scheduler] KPI集計に失敗しました:', err);
        }
      },
      { timezone: SERVICE_TIMEZONE },
    ),
  );

  // --- スタンプクリーンアップ: 毎日 深夜4時30分 ---
  tasks.push(
    cron.schedule(
      '30 4 * * *',
      async () => {
        try {
          await cleanupStamps();
        } catch (err) {
          console.error('[scheduler] スタンプクリーンアップに失敗しました:', err);
        }
      },
      { timezone: SERVICE_TIMEZONE },
    ),
  );

  // --- provision クリーンアップ: 毎時 ---
  tasks.push(
    cron.schedule(
      '30 * * * *',
      async () => {
        try {
          await cleanupProvisions();
        } catch (err) {
          console.error('[scheduler] provision クリーンアップに失敗しました:', err);
        }
      },
      { timezone: SERVICE_TIMEZONE },
    ),
  );

  // --- invite_codes クリーンアップ: 毎時（provision と同タイミング） ---
  tasks.push(
    cron.schedule(
      '30 * * * *',
      async () => {
        try {
          await cleanupInviteCodes();
        } catch (err) {
          console.error('[scheduler] invite_codes クリーンアップに失敗しました:', err);
        }
      },
      { timezone: SERVICE_TIMEZONE },
    ),
  );

  // 起動直後に判定を1回走らせる。
  // 次の分境界まで待つと、最大60秒間 job_runs が空のままになり
  // /healthz が 'never_ran' を返しうる。
  void tickEvaluator();

  console.log(`[scheduler] ${tasks.length}個のジョブを起動しました (TZ: ${SERVICE_TIMEZONE})`);
}

/**
 * 全ジョブを停止する（グレースフルシャットダウン用）。
 */
export async function stopScheduler(): Promise<void> {
  for (const task of tasks) {
    await task.stop();
  }
  tasks.length = 0;
  console.log('[scheduler] 全ジョブを停止しました');
}

/**
 * 期限切れの provision を物理削除する（毎時）。
 *
 * provision は認証なしで作成できるため、claim されずに放置されたレコードが蓄積する。
 * 有効期限 + 1時間（ポーリングのラグ猶予）を過ぎたものを削除する。
 * claimed 済みのレコードも一定期間（7日）後に削除する（device_token は発行済みのため不要）。
 */
async function cleanupProvisions(): Promise<number> {
  const res = await query(
    `DELETE FROM provisions
     WHERE (claimed_at IS NULL AND expires_at < now() - interval '1 hour')
        OR (claimed_at IS NOT NULL AND claimed_at < now() - interval '7 days')`,
  );
  const deleted = res.rowCount ?? 0;
  if (deleted > 0) {
    console.log(`[scheduler] 期限切れ provision を${deleted}件削除しました`);
  }
  return deleted;
}

/**
 * 90日経過したスタンプを物理削除する（日次）。
 *
 * スタンプは軽い近況報告であり、長期保存の価値は低い。
 */
async function cleanupStamps(): Promise<number> {
  const res = await query(
    `DELETE FROM stamps WHERE created_at < now() - interval '90 days'`,
  );
  const deleted = res.rowCount ?? 0;
  if (deleted > 0) {
    console.log(`[scheduler] 90日経過スタンプを${deleted}件削除しました`);
  }
  return deleted;
}

/**
 * 期限切れの invite_codes を物理削除する（毎時）。
 * provision と同じポリシー: 未使用は期限+1時間、使用済みは7日後に削除。
 */
async function cleanupInviteCodes(): Promise<number> {
  const res = await query(
    `DELETE FROM invite_codes
     WHERE (joined_at IS NULL AND expires_at < now() - interval '1 hour')
        OR (joined_at IS NOT NULL AND joined_at < now() - interval '7 days')`,
  );
  const deleted = res.rowCount ?? 0;
  if (deleted > 0) {
    console.log(`[scheduler] 期限切れ invite_codes を${deleted}件削除しました`);
  }
  return deleted;
}

// テスト・運用スクリプトから個別に呼べるように公開する
export { purgeSosLocations, summarizeKpi, detectAndReportOutage, cleanupProvisions, cleanupStamps, cleanupInviteCodes };
