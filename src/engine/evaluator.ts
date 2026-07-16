/**
 * 判定ジョブ（原則2「デッドマンスイッチはサーバー側判定」の実装）。
 *
 * 毎分実行され、全アクティブクライアントの経過時間を評価する。
 * 端末が壊れた・電池が切れた・圏外になった時こそアラートが必要なので、
 * 判定は必ずサーバーが行う。端末からの「異常です」という申告には依存しない。
 *
 * このジョブが止まること = 見守りが止まること。
 * したがって最終実行時刻を job_runs に記録し、/healthz が監視する。
 */
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import {
  notifyAlert,
  notifyClientConfirming,
  notifyWatch,
  sendSilentPush,
} from '../notify/dispatcher.js';
import { evaluate, type ClientStatus, type EvaluationParams } from './state.js';
import { getEffectiveThreshold } from './thresholds.js';

/** 判定ジョブ名（job_runs のキー） */
export const EVALUATOR_JOB_NAME = 'evaluator';

/** DBから読む判定対象クライアントの行 */
interface ClientRow {
  id: string;
  status: ClientStatus;
  last_alive_event_at: Date;
  last_heartbeat_at: Date | null;
  confirming_since: Date | null;
  last_alert_notified_at: Date | null;
  silent_push_sent_at: Date | null;
  last_weak_signal_at: Date | null;
  has_app: boolean;
  threshold_minutes: number;
}

/** ジョブ1回の実行結果（監視・デバッグ用） */
export interface EvaluationRunResult {
  evaluated: number;
  transitions: number;
  notifications: number;
  errors: number;
}

/**
 * config から判定パラメータを組み立てる。
 */
function paramsFromConfig(): EvaluationParams {
  return {
    confirmingTimeoutMinutes: config.CONFIRMING_TIMEOUT_MINUTES,
    alertRenotifyHours: config.ALERT_RENOTIFY_HOURS,
    noAppGraceMinutes: config.NO_APP_GRACE_MINUTES,
    weakSignalFreshMinutes: config.WEAK_SIGNAL_FRESH_MINUTES,
    crossCheckHoldMinutes: config.CROSS_CHECK_HOLD_MINUTES,
  };
}

/**
 * クライアント1件を判定し、必要なら状態遷移と通知を行う。
 *
 * @param row - 判定対象クライアント
 * @param now - 判定基準時刻
 * @returns 遷移・通知が発生したか
 */
async function evaluateClient(
  row: ClientRow,
  now: Date,
): Promise<{ transitioned: boolean; notified: boolean }> {
  // 有効閾値を求める（学習値 or デフォルト）
  const threshold = await getEffectiveThreshold(row.id, row.threshold_minutes, now);

  const decision = evaluate(
    {
      status: row.status,
      lastAliveEventAt: row.last_alive_event_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      confirmingSince: row.confirming_since,
      lastAlertNotifiedAt: row.last_alert_notified_at,
      silentPushSentAt: row.silent_push_sent_at,
      lastWeakSignalAt: row.last_weak_signal_at,
      hasApp: row.has_app,
      thresholdMinutes: threshold.minutes,
    },
    now,
    paramsFromConfig(),
  );

  let transitioned = false;
  let notified = false;

  // --- 1. 状態遷移をDBへ反映 ---
  // 通知の前にDBを更新する。通知失敗で状態遷移が失われると、
  // 次周回で同じ遷移を再試行し通知が重複するため。
  // （通知が飛ばないより、状態が正しい方が優先。通知失敗は audit_log に残る）
  if (decision.nextStatus && decision.nextStatus !== row.status) {
    await withTransaction(async (client) => {
      // 楽観的ロック相当のガード:
      // 判定中に生存イベントが届いて ALIVE へ復帰している可能性がある。
      // status が読み取り時点から変わっていない場合のみ遷移させる。
      // これがないと「本人が操作して復帰した直後にALERTを発報する」事故が起きる。
      const res = await client.query(
        `UPDATE clients
            SET status = $2,
                status_changed_at = now(),
                confirming_since = CASE WHEN $2 = 'CONFIRMING' THEN now() ELSE confirming_since END
          WHERE id = $1 AND status = $3`,
        [row.id, decision.nextStatus, row.status],
      );

      if ((res.rowCount ?? 0) === 0) {
        // 競合により遷移をスキップ。次周回で再評価される。
        transitioned = false;
        return;
      }

      await audit(
        row.id,
        'status_change',
        {
          from: row.status,
          to: decision.nextStatus,
          reason: decision.reason,
          threshold_minutes: threshold.minutes,
          threshold_mode: threshold.mode,
          device_silent: decision.deviceSilent,
        },
        client,
      );
      transitioned = true;
    });

    // 遷移が競合でスキップされた場合、通知も送らない
    if (!transitioned) return { transitioned: false, notified: false };
  }

  // --- 2. 通知 ---
  if (decision.notifyClientConfirming) {
    await notifyClientConfirming(row.id);
    notified = true;
  }

  if (decision.notifyWatchers === 'watch') {
    await notifyWatch(row.id);
    notified = true;
  } else if (decision.notifyWatchers === 'alert') {
    await notifyAlert(row.id, decision.deviceSilent);
    notified = true;
  }

  // --- 3. silent push（端末を起こしにいく） ---
  if (decision.sendSilentPush) {
    await sendSilentPush(row.id);
    // 同一沈黙期間中の多重送信を防ぐ。生存イベント受信でクリアされる。
    await query('UPDATE clients SET silent_push_sent_at = now() WHERE id = $1', [row.id]);
  }

  return { transitioned, notified };
}

/**
 * 判定ジョブを1回実行する。
 *
 * 【重要】1クライアントの判定失敗が他のクライアントの判定を止めてはならない。
 * 1人の見守りが壊れて全員の見守りが止まるのは許容できない。
 * したがって各クライアントの処理を個別に try/catch する。
 *
 * @param now - 判定基準時刻（テスト時に固定できるよう引数化）
 * @returns 実行結果
 */
export async function runEvaluation(now: Date = new Date()): Promise<EvaluationRunResult> {
  const result: EvaluationRunResult = {
    evaluated: 0,
    transitions: 0,
    notifications: 0,
    errors: 0,
  };

  // SOS は手動resolveのみのため判定対象外（spec 5.2）
  const clients = await query<ClientRow>(
    `SELECT id, status, last_alive_event_at, last_heartbeat_at, confirming_since,
            last_alert_notified_at, silent_push_sent_at, last_weak_signal_at,
            has_app, threshold_minutes
       FROM clients
      WHERE status <> 'SOS'`,
  );

  for (const row of clients.rows) {
    result.evaluated++;
    try {
      const r = await evaluateClient(row, now);
      if (r.transitioned) result.transitions++;
      if (r.notified) result.notifications++;
    } catch (err) {
      result.errors++;
      console.error(`[evaluator] クライアント ${row.id} の判定に失敗:`, err);
      await audit(row.id, 'notification_failed', {
        reason: 'evaluation_error',
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {
        // 監査ログ自体が失敗しても判定ループは止めない
      });
    }
  }

  // --- 最終実行時刻を記録（サービス自身のデッドマンスイッチ） ---
  await query(
    `INSERT INTO job_runs (job_name, last_run_at, last_status, detail)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (job_name) DO UPDATE
       SET last_run_at = EXCLUDED.last_run_at,
           last_status = EXCLUDED.last_status,
           detail      = EXCLUDED.detail`,
    [
      EVALUATOR_JOB_NAME,
      result.errors > 0 ? 'partial_failure' : 'ok',
      JSON.stringify(result),
    ],
  );

  return result;
}
