/**
 * 状態遷移の定義と純粋な判定ロジック。
 *
 * このモジュールは意図的に「純粋関数」に保つ（DB・通知・時刻取得を含まない）。
 * 判定ロジックは製品の心臓部であり、単体テストで網羅できることが
 * 誤報率KPIを守る前提になるため。
 * 副作用（DB更新・通知）は evaluator.ts が担う。
 */

/** クライアントの状態 */
export type ClientStatus = 'ALIVE' | 'WATCH' | 'CONFIRMING' | 'ALERT' | 'SOS';

/** 判定に必要な入力（DBから読んだ値をそのまま写したもの） */
export interface EvaluationInput {
  status: ClientStatus;
  /** 最後の「本人が生きている」イベント時刻 */
  lastAliveEventAt: Date;
  /** 最後のハートビート受信時刻（操作の有無を問わない）。null = 一度も未受信 */
  lastHeartbeatAt: Date | null;
  /** CONFIRMING に入った時刻 */
  confirmingSince: Date | null;
  /** 最後に ALERT を通知した時刻 */
  lastAlertNotifiedAt: Date | null;
  /** silent push を送った時刻 */
  silentPushSentAt: Date | null;
  /**
   * 低信頼ソース（電力メーター等）からの最終シグナル時刻（Phase 2）。
   * 【重要】これは生存の証拠ではない。経過時間の基準点にしてはならない。
   * クロス判定（本人確認を届けられない状況でのALERT保留）にのみ使う。
   */
  lastWeakSignalAt: Date | null;
  /** アプリを持つクライアントか（false = センサーのみ物件） */
  hasApp: boolean;
  /** 有効閾値（分） */
  thresholdMinutes: number;
}

/** 判定パラメータ（config から注入。テスト時に差し替える） */
export interface EvaluationParams {
  confirmingTimeoutMinutes: number;
  alertRenotifyHours: number;
  noAppGraceMinutes: number;
  /** 弱シグナルを「まだ新しい」とみなす時間（分）。Phase 2 クロス判定用。 */
  weakSignalFreshMinutes: number;
  /** クロス判定がALERTを保留できる最大時間（分）。Phase 2。 */
  crossCheckHoldMinutes: number;
}

/** 判定の結果として実行すべきアクション */
export interface EvaluationDecision {
  /** 遷移先の状態。null = 状態変更なし */
  nextStatus: ClientStatus | null;
  /** クライアント端末へ全画面通知（本人確認）を送るか */
  notifyClientConfirming: boolean;
  /** ウォッチャーへ通知するか、およびその種別 */
  notifyWatchers: 'watch' | 'alert' | null;
  /** 端末を起こしにいく silent push を送るか */
  sendSilentPush: boolean;
  /**
   * 端末沈黙（ハートビート自体が途絶）しているか。
   * ALERT時の文言を「電池切れ・電源OFFの可能性を含む」に変えるために使う。
   */
  deviceSilent: boolean;
  /** 判定理由（監査ログ用） */
  reason: string;
}

/** 何もしない決定 */
const NO_OP: EvaluationDecision = {
  nextStatus: null,
  notifyClientConfirming: false,
  notifyWatchers: null,
  sendSilentPush: false,
  deviceSilent: false,
  reason: 'no_change',
};

/** WATCH に入る閾値の割合（spec: 閾値×0.8） */
export const WATCH_RATIO = 0.8;
/** silent push を送る閾値の割合（spec 5.1: 閾値の50%経過時点） */
export const SILENT_PUSH_RATIO = 0.5;

/**
 * 2時刻の差を分で返す。
 *
 * @param a - 後の時刻
 * @param b - 前の時刻
 * @returns 差（分）。負にはならないようクランプする
 */
function diffMinutes(a: Date, b: Date): number {
  return Math.max(0, (a.getTime() - b.getTime()) / 60_000);
}

/**
 * ハートビートが途絶しているか（端末沈黙）を判定する。
 *
 * 「端末が生きている」と「本人が生きている」の区別（spec 5.1）。
 * 端末は15分周期でハートビートを送るため、その3倍（45分）以上途絶したら
 * 端末側の問題（電池切れ・電源OFF・タスクキラー）とみなす。
 *
 * @param lastHeartbeatAt - 最後のハートビート受信時刻
 * @param now - 現在時刻
 * @returns 端末が沈黙していれば true
 */
export function isDeviceSilent(lastHeartbeatAt: Date | null, now: Date): boolean {
  // 一度もハートビートが来ていない = ペアリング直後。まだ沈黙とは判定しない。
  if (!lastHeartbeatAt) return false;
  return diffMinutes(now, lastHeartbeatAt) >= 45;
}

/**
 * 弱シグナルがまだ新しいか（＝低信頼ソース自体が生きているか）を判定する。
 *
 * @param lastWeakSignalAt - 最後の弱シグナル時刻
 * @param now - 現在時刻
 * @param freshMinutes - 新しいとみなす上限（分）
 * @returns 新しければ true
 */
export function hasFreshWeakSignal(
  lastWeakSignalAt: Date | null,
  now: Date,
  freshMinutes: number,
): boolean {
  if (!lastWeakSignalAt) return false;
  return diffMinutes(now, lastWeakSignalAt) < freshMinutes;
}

/**
 * クロス判定: 弱シグナルを根拠に ALERT への進行を保留してよいかを判定する（spec 5.2）。
 *
 * 【解決したい誤報】
 * 端末沈黙（電池切れ）だけを理由に ALERT を出すと、
 * 「スマホの電池が切れただけで元気な親」に対して警告が飛ぶ。
 * これは誤報率KPI（5%未満）を壊す代表的なパターンであり、
 * 繰り返せばウォッチャーが通知を無視するようになる（狼少年化）= 見守りの死。
 *
 * 【適用条件を「本人確認を届けられない場合」に限る理由】
 * 端末が生きているなら CONFIRMING（全画面通知）が届き、本人がタップで解除できる。
 * 本人のタップは弱シグナルより遥かに強い証拠であり、誤報の逃げ道として既に機能している。
 * その経路が使える限り、弱シグナルで判定を鈍らせる必要はない。
 * 逆に端末が沈黙している / そもそもアプリが無い場合は本人に問い合わせる手段が無いため、
 * 弱シグナルが唯一の追加情報になる。
 *
 * 【上限時間が必須である理由 — ここを外すと人が死ぬ】
 * 弱シグナル（家全体の電力変動）は、本人が倒れていても発生し続ける。
 * 冷蔵庫・給湯器・待機電力は住人の生死と無関係に動く。
 * したがって「弱シグナルがある限り保留」にすると、デッドマンスイッチが
 * 永久に発報しない。誤報を防ぐための仕組みが検知漏れを生むのは本末転倒であり、
 * 「見守っているつもりで誰も見ていない」状態はこのサービスで唯一許されない失敗。
 * よって保留は crossCheckHoldMinutes までとし、超えたら弱シグナルがあっても発報する。
 *
 * @param input - 判定入力
 * @param now - 判定基準時刻
 * @param params - 判定パラメータ
 * @param elapsed - 最終生存イベントからの経過時間（分）
 * @param threshold - 有効閾値（分）
 * @param deviceSilent - 端末沈黙中か
 * @returns 保留してよければ true
 */
export function crossCheckHolds(
  input: EvaluationInput,
  now: Date,
  params: EvaluationParams,
  elapsed: number,
  threshold: number,
  deviceSilent: boolean,
): boolean {
  // 本人確認を届けられるなら、そちらの方が確実。クロス判定は使わない。
  if (input.hasApp && !deviceSilent) return false;

  // 弱シグナル自体が途絶しているなら、保留する根拠がない。
  if (!hasFreshWeakSignal(input.lastWeakSignalAt, now, params.weakSignalFreshMinutes)) return false;

  // 本来エスカレーションが起きる時点からの追加猶予として上限を測る。
  const escalateAt = input.hasApp ? threshold : threshold + params.noAppGraceMinutes;
  return elapsed < escalateAt + params.crossCheckHoldMinutes;
}

/**
 * クライアント1件の状態を判定する（純粋関数）。
 *
 * 状態遷移ルール（spec 5.2）:
 *   経過時間 >= threshold × 0.8   → WATCH（注視）
 *   経過時間 >= threshold          → CONFIRMING: クライアント端末へ全画面通知
 *   CONFIRMING かつ 30分無応答     → ALERT: 全ウォッチャーへ強通知
 *   生存イベント受信               → 即 ALIVE（これは判定ジョブではなくイベント投入時に処理）
 *
 * SOS はこの関数では扱わない。SOSは同期パス（POST /v1/sos）で即時に処理され、
 * 手動 resolve でしか解除されないため、判定ジョブは SOS 状態のクライアントに触れない。
 *
 * @param input - 判定入力
 * @param now - 判定基準時刻
 * @param params - 判定パラメータ
 * @returns 実行すべきアクション
 */
export function evaluate(
  input: EvaluationInput,
  now: Date,
  params: EvaluationParams,
): EvaluationDecision {
  // SOS は最優先かつ手動解除のみ。判定ジョブは介入しない。
  if (input.status === 'SOS') return { ...NO_OP, reason: 'sos_requires_manual_resolve' };

  const elapsed = diffMinutes(now, input.lastAliveEventAt);
  const threshold = input.thresholdMinutes;
  const deviceSilent = isDeviceSilent(input.lastHeartbeatAt, now);

  // クロス判定（Phase 2）: 本人確認を届けられない状況で、他ソースが生きている間は
  // ALERT を保留し WATCH 止まりにする（spec 5.2）。上限あり。
  const crossHold = crossCheckHolds(input, now, params, elapsed, threshold, deviceSilent);

  // --- silent push（端末を起こしにいく補助経路） ---
  // 閾値の50%を超えてなお無操作なら、WorkManagerが殺されている可能性がある。
  // 同一沈黙期間中に一度だけ送る（silent_push_sent_at は生存イベントでクリアされる）。
  const shouldSilentPush =
    input.hasApp &&
    elapsed >= threshold * SILENT_PUSH_RATIO &&
    input.silentPushSentAt === null;

  // --- has_app = false（センサーのみクライアント）の別プロファイル ---
  // 端末がないので CONFIRMING（全画面通知）を出しても届かない。
  // よって CONFIRMING をスキップし、WATCH → 猶予 → ALERT とする（spec 8）。
  if (!input.hasApp) {
    if (elapsed >= threshold + params.noAppGraceMinutes) {
      // 既に ALERT の場合を先に処理する。
      // 【重要】クロス判定は ALERT への進行を止めるだけであり、
      // 既に出した ALERT を弱シグナルで取り下げてはならない。
      // ALERT の解除はウォッチャーの明示的な resolve のみ（誤報率KPIの計測基盤でもある）。
      if (input.status === 'ALERT') {
        if (shouldRenotifyAlert(input.lastAlertNotifiedAt, now, params.alertRenotifyHours)) {
          return {
            nextStatus: null,
            notifyClientConfirming: false,
            notifyWatchers: 'alert',
            sendSilentPush: false,
            deviceSilent,
            reason: 'alert_renotify',
          };
        }
        return { ...NO_OP, deviceSilent, reason: 'no_app_already_alert' };
      }

      // 他ソースが生きている間は WATCH 止まり（上限まで）
      if (crossHold) {
        if (input.status === 'ALIVE') {
          return {
            nextStatus: 'WATCH',
            notifyClientConfirming: false,
            notifyWatchers: 'watch',
            sendSilentPush: false,
            deviceSilent,
            reason: 'cross_check_hold',
          };
        }
        return { ...NO_OP, deviceSilent, reason: 'cross_check_hold' };
      }

      return {
        nextStatus: 'ALERT',
        notifyClientConfirming: false,
        notifyWatchers: 'alert',
        sendSilentPush: false,
        deviceSilent,
        reason: 'no_app_threshold_and_grace_exceeded',
      };
    }

    if (elapsed >= threshold * WATCH_RATIO && input.status === 'ALIVE') {
      return {
        nextStatus: 'WATCH',
        notifyClientConfirming: false,
        notifyWatchers: 'watch',
        sendSilentPush: false,
        deviceSilent,
        reason: 'no_app_watch_ratio_exceeded',
      };
    }

    return { ...NO_OP, deviceSilent, reason: 'no_app_within_threshold' };
  }

  // --- 通常プロファイル（アプリありクライアント） ---

  // 閾値超過
  if (elapsed >= threshold) {
    // ALIVE / WATCH から → CONFIRMING（本人確認。誤報の逃げ道）
    if (input.status === 'ALIVE' || input.status === 'WATCH') {
      // クロス判定成立時は CONFIRMING へ進めず WATCH 止まりにする（spec 5.2）。
      // 端末が沈黙している以上、全画面通知を出しても届く見込みが薄い。
      // 届かない本人確認を経由して自動的に ALERT へ落ちるくらいなら、
      // 他ソースが生きている事実を採用して WATCH に留める方が誤報が少ない。
      // なお端末を叩き起こす試み自体は silent push が別経路で継続する。
      if (crossHold) {
        if (input.status === 'ALIVE') {
          return {
            nextStatus: 'WATCH',
            notifyClientConfirming: false,
            notifyWatchers: 'watch',
            sendSilentPush: shouldSilentPush,
            deviceSilent,
            reason: 'cross_check_hold',
          };
        }
        return { ...NO_OP, sendSilentPush: shouldSilentPush, deviceSilent, reason: 'cross_check_hold' };
      }

      return {
        nextStatus: 'CONFIRMING',
        notifyClientConfirming: true,
        notifyWatchers: null,
        sendSilentPush: shouldSilentPush,
        deviceSilent,
        reason: 'threshold_exceeded',
      };
    }

    // CONFIRMING から → 無応答が続けば ALERT
    if (input.status === 'CONFIRMING') {
      // confirming_since が欠落している場合は status_changed_at 相当の情報がないため、
      // 安全側（まだタイムアウトしていない）に倒す。次周回で confirming_since が
      // 設定され次第、正しくタイムアウト判定される。
      if (!input.confirmingSince) {
        return { ...NO_OP, deviceSilent, reason: 'confirming_since_missing' };
      }
      if (diffMinutes(now, input.confirmingSince) >= params.confirmingTimeoutMinutes) {
        // CONFIRMING 中に端末が沈黙し、かつ他ソースが生きている場合。
        // 本人が「無応答」なのではなく「応答手段を失った」可能性が高いため、
        // 上限時間まで ALERT を保留する。
        // 【注意】ここで WATCH へ引き下げることはしない。状態の巻き戻しは
        // ウォッチャーから見て「一度確認中になったものが理由なく戻った」ように映り、
        // 表示の信頼性を損なう。保留するのは発報だけでよい。
        if (crossHold) {
          return { ...NO_OP, deviceSilent, reason: 'cross_check_hold_confirming' };
        }
        return {
          nextStatus: 'ALERT',
          notifyClientConfirming: false,
          notifyWatchers: 'alert',
          sendSilentPush: false,
          deviceSilent,
          reason: 'confirming_timeout',
        };
      }
      return { ...NO_OP, deviceSilent, reason: 'confirming_awaiting_response' };
    }

    // 既に ALERT。24時間ごとに再通知（spec 5.4）。
    if (input.status === 'ALERT') {
      if (shouldRenotifyAlert(input.lastAlertNotifiedAt, now, params.alertRenotifyHours)) {
        return {
          nextStatus: null,
          notifyClientConfirming: false,
          notifyWatchers: 'alert',
          sendSilentPush: false,
          deviceSilent,
          reason: 'alert_renotify',
        };
      }
      return { ...NO_OP, deviceSilent, reason: 'already_alert' };
    }
  }

  // 閾値の80%超過 → WATCH（注視）
  if (elapsed >= threshold * WATCH_RATIO) {
    if (input.status === 'ALIVE') {
      return {
        nextStatus: 'WATCH',
        notifyClientConfirming: false,
        notifyWatchers: 'watch',
        sendSilentPush: shouldSilentPush,
        deviceSilent,
        reason: 'watch_ratio_exceeded',
      };
    }
    // 既に WATCH 以上。多重通知はしない（spec 5.4「同一状態への遷移通知は
    // 状態が変わるまで再送しない」）。
    return {
      ...NO_OP,
      sendSilentPush: shouldSilentPush,
      deviceSilent,
      reason: 'already_watch_or_beyond',
    };
  }

  // 閾値内。silent push だけは条件を満たせば送る。
  return {
    ...NO_OP,
    sendSilentPush: shouldSilentPush,
    deviceSilent,
    reason: 'within_threshold',
  };
}

/**
 * ALERT の再通知が必要かを判定する。
 *
 * 見守りが必要な状態が継続しているのにウォッチャーが気づいていない可能性があるため、
 * ALERT だけは24時間ごとに再通知する（他の状態は状態が変わるまで再送しない）。
 *
 * @param lastAlertNotifiedAt - 最後にALERTを通知した時刻
 * @param now - 現在時刻
 * @param renotifyHours - 再通知間隔（時間）
 * @returns 再通知すべきなら true
 */
export function shouldRenotifyAlert(
  lastAlertNotifiedAt: Date | null,
  now: Date,
  renotifyHours: number,
): boolean {
  if (!lastAlertNotifiedAt) return true;
  return diffMinutes(now, lastAlertNotifiedAt) >= renotifyHours * 60;
}
