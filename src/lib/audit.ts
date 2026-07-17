/**
 * 監査ログ。
 *
 * 全ての状態遷移と通知結果を記録する。これは免責の証跡であり、
 * 紛争時に「いつ検知し、いつ通知したか」を示す唯一の根拠になる（spec 7.2）。
 *
 * 【重要】
 * - audit_log の行は削除しない（SOSのpurge対象外）
 * - detail に位置情報・行動詳細を入れてはならない（位置は sos_incidents のみ）
 */
import type { PoolClient } from 'pg';
import { query } from '../db/pool.js';

/** 監査対象のイベント種別 */
export type AuditEvent =
  | 'status_change'        // 状態遷移
  | 'notification_sent'    // 通知成功
  | 'notification_failed'  // 通知失敗（リトライ枯渇）
  | 'confirm_alive'        // 本人確認への応答
  | 'sos_fired'            // SOS発動
  | 'sos_resolved'         // SOS解決
  | 'client_paired'        // ペアリング完了（同意記録を含む）
  | 'client_claimed'       // 逆方向ペアリング（provision → claim）完了
  | 'watcher_joined'       // 追加ウォッチャーの招待 join（多対多）
  | 'permission_health'    // 権限失効の申告
  | 'threshold_learned'    // 閾値の学習更新
  | 'silent_push_sent'     // 端末を起こしにいく silent push
  | 'service_outage'       // サービス停止の検知・通知
  | 'sos_purged'           // 位置情報の物理削除
  // --- Phase 2: センサー連携 ---
  // 見守りの経路が増減した事実は免責の証跡として残す必要がある。
  // 「事故当時、そのセンサーは有効だったのか」に後から答えられなければ、
  // 監視していたことを証明できない。
  | 'sensor_registered'    // センサーの登録
  | 'sensor_updated'       // センサーの有効/無効の切り替え
  | 'sensor_removed';      // センサーの登録解除

/**
 * 監査ログを1件記録する。
 *
 * 監査ログの書き込み失敗が業務処理を巻き込んで失敗させないよう、
 * 例外は握り潰してログ出力に留める（記録より本体の継続を優先）。
 * ただしトランザクション内で呼ぶ場合は tx を渡すこと。
 *
 * @param clientId - 対象クライアントID（システム全体のイベントなら null）
 * @param event - イベント種別
 * @param detail - 詳細（位置情報・行動詳細は入れない）
 * @param tx - トランザクション用クライアント（省略時はプールから取得）
 */
export async function audit(
  clientId: string | null,
  event: AuditEvent,
  detail: Record<string, unknown> = {},
  tx?: PoolClient,
): Promise<void> {
  const sql = 'INSERT INTO audit_log (client_id, event, detail) VALUES ($1, $2, $3)';
  const params = [clientId, event, JSON.stringify(detail)];
  try {
    if (tx) {
      await tx.query(sql, params);
    } else {
      await query(sql, params);
    }
  } catch (err) {
    // トランザクション内の場合、ここで握り潰すとトランザクション自体が
    // aborted 状態のまま進むため再スローする。
    if (tx) throw err;
    console.error('[audit] 監査ログの記録に失敗しました:', event, err);
  }
}
