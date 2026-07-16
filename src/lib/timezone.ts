/**
 * タイムゾーンの明示的な固定。
 *
 * 【なぜ必要か】
 * 閾値学習は「曜日 × 時間帯」のバケットに生活サイクルを写像する。
 * 生活サイクルは本質的に現地時刻に紐づく（その人の深夜3時は現地の3時であって
 * UTCの3時ではない）。
 *
 * ここを暗黙のシステムTZ任せにすると、
 *   - 学習側（SQLの EXTRACT）はDBセッションTZ
 *   - 参照側（JSの getHours）はNodeプロセスのTZ
 * が食い違い、「学習したバケット」と「判定時に参照するバケット」がズレる。
 * ズレた閾値は誤報か検知漏れに直結し、KPI（誤報率5%未満）を直接壊す。
 *
 * したがってTZは環境に依存させず、コード上で1箇所に固定する。
 * Phase 1 は日本国内向け（多言語対応も日本語のみ）のため Asia/Tokyo。
 *
 * TODO(Phase 4): 海外展開時はクライアント単位の timezone カラムを持たせ、
 * この定数を clients.timezone に置き換える。SQL側も同様にパラメータ化する。
 */

/** サービスの基準タイムゾーン。学習・判定の双方がこれを使う。 */
export const SERVICE_TIMEZONE = 'Asia/Tokyo';

/**
 * 基準TZにおける「曜日」と「時」を取り出す。
 *
 * Date#getHours() はNodeのローカルTZに依存するため使わない。
 * Intl.DateTimeFormat で明示的に基準TZへ変換する。
 *
 * @param date - 対象時刻（UTC基準の Date）
 * @returns 基準TZでの曜日(0=日)と時(0-23)
 */
export function localPartsOf(date: Date): { dow: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: SERVICE_TIMEZONE,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });

  const parts = fmt.formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '0';

  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  // hour12:false でも環境によっては 24 を返す場合があるため 0 に正規化する
  const hour = Number(hourRaw) % 24;

  return { dow: dowMap[weekday] ?? 0, hour };
}
