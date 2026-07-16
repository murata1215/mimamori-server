/**
 * ソース種別のレジストリ（Phase 2: アダプタ規約の実装点）。
 *
 * 【このモジュールの責務】
 * 「そのソースからのシグナルを、本人の生存の証拠としてどれだけ信用するか」
 * を一箇所に集約する。新しいソースを足すときに触るのはこのファイルと
 * アダプタ（Webhook ハンドラ）だけであり、判定エンジンは無改修である
 * （spec 8「改修が必要になった時点でアダプタ設計の失敗とみなす」）。
 *
 * 【confidence の意味を「強いシグナル / 弱いシグナル」の二値に落とす理由】
 * 判定エンジンが 0-100 の連続値を解釈し始めると、閾値をソースごとに
 * 重み付けする複雑な計算に発展し、誤報の原因が追跡不能になる。
 * 命に関わる判定は「なぜそう判定したか」を後から人間が説明できることが要件。
 * そこで confidence は「HIGH_CONFIDENCE_MIN 以上か否か」でのみ解釈する。
 * 数値そのものは監査ログ・将来の分析のために events へ保存する。
 */

/**
 * 強いシグナルとみなす最小 confidence。
 *
 * これ以上のソースからの activity は「本人が生きている」の証拠として採用し、
 * 経過時間をリセットする（= 即 ALIVE 復帰）。
 * これ未満は弱シグナルとして扱い、経過時間をリセットしない。
 *
 * 80 という値は spec 8 の「電力30分値は confidence 70程度の低信頼ソース」と、
 * それ以外の直接的な行動シグナル（開閉・消費電力）を分離する位置に置いてある。
 */
export const HIGH_CONFIDENCE_MIN = 80;

/** ソース種別の定義 */
export interface SourceDefinition {
  /** events.source_type に書く値 */
  sourceType: string;
  /** このソースからのイベントに付与する confidence */
  confidence: number;
  /** 人間向けの説明（API・ドキュメント用） */
  label: string;
}

/**
 * Phase 2 で対応するセンサーソース。
 *
 * 【confidence の割り当て根拠】
 * - switchbot_contact (100): ドアの開閉。物理的に誰かが動かさないと起きない。
 *   本人の行動とみなしてよい。
 * - switchbot_plug (100): 特定の家電（ポット等）の消費電力変化。
 *   プラグは「その家電」1台に紐づくため、ポットが沸いた = 誰かが沸かした。
 *   本人の行動とみなしてよい。
 * - power_meter (70): 家全体の30分値。冷蔵庫・給湯器・待機電力など、
 *   本人が動かなくても変動する負荷が混ざる。本人の行動とみなしてはならない。
 *   spec 8 が明示的に「低信頼ソース」と指定している唯一のソース。
 */
export const SOURCE_DEFINITIONS: Record<string, SourceDefinition> = {
  switchbot_contact: {
    sourceType: 'switchbot_contact',
    confidence: 100,
    label: '開閉センサー',
  },
  switchbot_plug: {
    sourceType: 'switchbot_plug',
    confidence: 100,
    label: 'スマートプラグ',
  },
  power_meter: {
    sourceType: 'power_meter',
    confidence: 70,
    label: '電力メーター（30分値）',
  },
};

/** 登録可能なソース種別の一覧 */
export const SENSOR_SOURCE_TYPES = Object.keys(SOURCE_DEFINITIONS) as [string, ...string[]];

/**
 * ソース種別の既定 confidence を返す。
 *
 * 【なぜ登録側・Webhook側から confidence を受け取らないのか】
 * 外部から confidence を指定できると、低信頼ソースが自分を高信頼と
 * 申告できてしまう。「端末が自分の状態を申告する設計にしない」(原則2) と
 * 同じ理由で、信頼度の決定権はサーバーだけが持つ。
 *
 * @param sourceType - ソース種別
 * @returns confidence（未知のソースは弱シグナル扱いの 0 を返す）
 */
export function confidenceOf(sourceType: string): number {
  return SOURCE_DEFINITIONS[sourceType]?.confidence ?? 0;
}

/**
 * confidence が「強いシグナル」に相当するかを判定する。
 *
 * @param confidence - 0-100
 * @returns 強いシグナルなら true（= 生存イベントとして経過時間をリセットしてよい）
 */
export function isHighConfidence(confidence: number): boolean {
  return confidence >= HIGH_CONFIDENCE_MIN;
}
