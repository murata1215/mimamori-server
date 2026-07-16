/**
 * センサー登録の逆引き（Phase 2 アダプタの共通部品）。
 *
 * Webhook が持っている情報は「どのデバイスからか」だけ（SwitchBot なら deviceMac）。
 * それを「誰の見守りのイベントか」へ解決するのがこのモジュールの責務。
 *
 * 全てのアダプタ（SwitchBot・電力メーター・将来の新ソース）がこの1経路を通る。
 * ここが唯一の解決点であることで、「登録されていないデバイスからのイベントを
 * 誤って受け入れる」経路が生まれないようにしている。
 */
import { query } from '../db/pool.js';

/** 解決されたセンサー */
export interface ResolvedSensor {
  id: string;
  clientId: string;
  /**
   * 登録時に確定した source_type。
   *
   * 【重要】Webhook ペイロードの形から source_type を推測してはならない。
   * ペイロードは外部から来る値であり、形が変われば推測は破綻する。
   * 「この MAC は開閉センサーである」と決めたのは登録時のウォッチャーであり、
   * その申告こそが権威ある情報。
   */
  sourceType: string;
  /** 登録時に確定した confidence（外部から上書きできない） */
  confidence: number;
}

/**
 * デバイス識別子からセンサー登録を解決する。
 *
 * 無効化（enabled=false）されたセンサーは解決しない。
 * 「電池交換中なので一旦切る」と設定した装置のイベントを受け付けると、
 * ウォッチャーの意図に反して判定材料に混ざる。
 *
 * @param sourceId - デバイス識別子（deviceMac 等）
 * @returns 解決結果。未登録・無効なら null
 */
export async function resolveSensor(sourceId: string): Promise<ResolvedSensor | null> {
  const res = await query<{
    id: string;
    client_id: string;
    source_type: string;
    confidence: number;
  }>(
    `SELECT id, client_id, source_type, confidence
       FROM client_sensors
      WHERE source_id = $1 AND enabled = true`,
    [sourceId],
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    clientId: row.client_id,
    sourceType: row.source_type,
    confidence: row.confidence,
  };
}

/**
 * センサーの最終イベント時刻を更新する（運用・障害調査用）。
 *
 * 【注意】この値をウォッチャー向けAPIで返してはならない。
 * 「玄関が最後に開いた時刻」そのものであり、原則1に反する。
 *
 * 判定には使わないため、失敗しても Webhook 全体を失敗させない
 * （イベント自体は既に events へ入っている方が重要）。
 *
 * @param sensorId - センサーID
 * @param occurredAt - イベント発生時刻
 */
export async function touchSensor(sensorId: string, occurredAt: Date): Promise<void> {
  await query(
    `UPDATE client_sensors
        SET last_event_at = GREATEST(COALESCE(last_event_at, $2), $2)
      WHERE id = $1`,
    [sensorId, occurredAt],
  );
}
