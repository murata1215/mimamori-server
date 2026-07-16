/**
 * 状態遷移ロジックの単体テスト。
 *
 * 判定ロジックは製品の心臓部であり、誤報率KPI（5%未満）を守る前提が
 * 「この遷移が仕様通りであること」なので、境界値を網羅する。
 *
 * ここが壊れると、最悪の場合「本人が倒れているのに生存と判定する」か
 * 「無事なのに毎晩警告が飛ぶ」のどちらかが起きる。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  isDeviceSilent,
  shouldRenotifyAlert,
  SILENT_PUSH_RATIO,
  WATCH_RATIO,
  type EvaluationInput,
  type EvaluationParams,
} from '../src/engine/state.js';

/** テスト用の判定パラメータ */
const params: EvaluationParams = {
  confirmingTimeoutMinutes: 30,
  alertRenotifyHours: 24,
  noAppGraceMinutes: 60,
  weakSignalFreshMinutes: 90,
  crossCheckHoldMinutes: 180,
};

/** 基準時刻 */
const NOW = new Date('2026-07-16T12:00:00+09:00');

/** 閾値600分（10時間）のクライアントを作る */
function makeInput(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    status: 'ALIVE',
    lastAliveEventAt: NOW,
    lastHeartbeatAt: NOW,
    confirmingSince: null,
    lastAlertNotifiedAt: null,
    silentPushSentAt: null,
    // 既定は「弱シグナルなし」。クロス判定は明示的に指定したテストでのみ効く。
    lastWeakSignalAt: null,
    hasApp: true,
    thresholdMinutes: 600,
    ...overrides,
  };
}

/** NOW から minutes 分前の時刻 */
function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe('evaluate — 通常プロファイル（アプリあり）', () => {
  it('閾値内なら状態を変えない', () => {
    const d = evaluate(makeInput({ lastAliveEventAt: minutesAgo(100) }), NOW, params);
    expect(d.nextStatus).toBeNull();
    expect(d.notifyWatchers).toBeNull();
  });

  it('閾値の80%を超えたら WATCH へ遷移しウォッチャーへ通知する', () => {
    // 600 * 0.8 = 480分
    const d = evaluate(makeInput({ lastAliveEventAt: minutesAgo(480) }), NOW, params);
    expect(d.nextStatus).toBe('WATCH');
    expect(d.notifyWatchers).toBe('watch');
    expect(d.notifyClientConfirming).toBe(false);
  });

  it('80%のちょうど手前では WATCH にしない（境界値）', () => {
    const d = evaluate(makeInput({ lastAliveEventAt: minutesAgo(479) }), NOW, params);
    expect(d.nextStatus).toBeNull();
  });

  it('既に WATCH なら再度 WATCH 通知を送らない（多重通知の防止）', () => {
    const d = evaluate(
      makeInput({ status: 'WATCH', lastAliveEventAt: minutesAgo(500) }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBeNull();
    expect(d.notifyWatchers).toBeNull();
  });

  it('閾値を超えたら CONFIRMING へ遷移し、クライアントへ全画面通知を送る', () => {
    const d = evaluate(makeInput({ lastAliveEventAt: minutesAgo(600) }), NOW, params);
    expect(d.nextStatus).toBe('CONFIRMING');
    expect(d.notifyClientConfirming).toBe(true);
    // 【重要】CONFIRMING の時点ではウォッチャーへ通知しない。
    // 本人確認で解除できる誤報をウォッチャーに見せない（KPI: 解除率90%）。
    expect(d.notifyWatchers).toBeNull();
  });

  it('WATCH からでも閾値超過で CONFIRMING へ進む', () => {
    const d = evaluate(
      makeInput({ status: 'WATCH', lastAliveEventAt: minutesAgo(700) }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBe('CONFIRMING');
    expect(d.notifyClientConfirming).toBe(true);
  });

  it('CONFIRMING が30分無応答なら ALERT へ遷移しウォッチャーへ通知する', () => {
    const d = evaluate(
      makeInput({
        status: 'CONFIRMING',
        lastAliveEventAt: minutesAgo(700),
        confirmingSince: minutesAgo(30),
      }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBe('ALERT');
    expect(d.notifyWatchers).toBe('alert');
  });

  it('CONFIRMING が30分未満なら ALERT へ進めない（本人確認の猶予を守る）', () => {
    const d = evaluate(
      makeInput({
        status: 'CONFIRMING',
        lastAliveEventAt: minutesAgo(700),
        confirmingSince: minutesAgo(29),
      }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBeNull();
    expect(d.notifyWatchers).toBeNull();
  });

  it('confirming_since が欠落していたら安全側（ALERTにしない）に倒す', () => {
    const d = evaluate(
      makeInput({
        status: 'CONFIRMING',
        lastAliveEventAt: minutesAgo(700),
        confirmingSince: null,
      }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBeNull();
    expect(d.reason).toBe('confirming_since_missing');
  });

  it('ALERT 中は24時間ごとに再通知する', () => {
    const d = evaluate(
      makeInput({
        status: 'ALERT',
        lastAliveEventAt: minutesAgo(2000),
        lastAlertNotifiedAt: minutesAgo(24 * 60),
      }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBeNull();
    expect(d.notifyWatchers).toBe('alert');
    expect(d.reason).toBe('alert_renotify');
  });

  it('ALERT 中でも24時間未満なら再通知しない', () => {
    const d = evaluate(
      makeInput({
        status: 'ALERT',
        lastAliveEventAt: minutesAgo(2000),
        lastAlertNotifiedAt: minutesAgo(60),
      }),
      NOW,
      params,
    );
    expect(d.notifyWatchers).toBeNull();
  });

  it('SOS 状態には判定ジョブが一切介入しない（手動resolveのみ）', () => {
    const d = evaluate(
      makeInput({ status: 'SOS', lastAliveEventAt: minutesAgo(5000) }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBeNull();
    expect(d.notifyWatchers).toBeNull();
    expect(d.sendSilentPush).toBe(false);
  });
});

describe('evaluate — silent push（端末を起こしにいく補助経路）', () => {
  it('閾値の50%経過で silent push を送る', () => {
    const d = evaluate(makeInput({ lastAliveEventAt: minutesAgo(300) }), NOW, params);
    expect(d.sendSilentPush).toBe(true);
    // まだ WATCH にはしない
    expect(d.nextStatus).toBeNull();
  });

  it('既に送信済みなら再送しない（多重送信の防止）', () => {
    const d = evaluate(
      makeInput({ lastAliveEventAt: minutesAgo(300), silentPushSentAt: minutesAgo(10) }),
      NOW,
      params,
    );
    expect(d.sendSilentPush).toBe(false);
  });

  it('アプリなしクライアントには silent push を送らない', () => {
    const d = evaluate(
      makeInput({ hasApp: false, lastAliveEventAt: minutesAgo(300) }),
      NOW,
      params,
    );
    expect(d.sendSilentPush).toBe(false);
  });

  it('50%の手前では送らない（境界値）', () => {
    const d = evaluate(makeInput({ lastAliveEventAt: minutesAgo(299) }), NOW, params);
    expect(d.sendSilentPush).toBe(false);
  });
});

describe('evaluate — 端末沈黙の区別', () => {
  it('ハートビートが45分以上途絶していたら端末沈黙と判定する', () => {
    expect(isDeviceSilent(minutesAgo(45), NOW)).toBe(true);
    expect(isDeviceSilent(minutesAgo(44), NOW)).toBe(false);
  });

  it('一度もハートビートが無い場合は沈黙と判定しない（ペアリング直後）', () => {
    expect(isDeviceSilent(null, NOW)).toBe(false);
  });

  it('ALERT遷移時、端末沈黙なら deviceSilent フラグが立つ（文言の切り替えに使う）', () => {
    const d = evaluate(
      makeInput({
        status: 'CONFIRMING',
        lastAliveEventAt: minutesAgo(700),
        lastHeartbeatAt: minutesAgo(700),
        confirmingSince: minutesAgo(31),
      }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBe('ALERT');
    expect(d.deviceSilent).toBe(true);
  });

  it('端末が生きていて操作だけ無い場合、deviceSilent は立たない', () => {
    const d = evaluate(
      makeInput({
        status: 'CONFIRMING',
        lastAliveEventAt: minutesAgo(700),
        lastHeartbeatAt: minutesAgo(5),
        confirmingSince: minutesAgo(31),
      }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBe('ALERT');
    expect(d.deviceSilent).toBe(false);
  });
});

describe('evaluate — アプリなしプロファイル（センサーのみ物件 / Phase 2）', () => {
  it('CONFIRMING をスキップし、閾値+猶予で直接 ALERT へ進む', () => {
    const d = evaluate(
      makeInput({ hasApp: false, lastAliveEventAt: minutesAgo(600 + 60) }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBe('ALERT');
    expect(d.notifyClientConfirming).toBe(false);
  });

  it('閾値超過でも猶予時間内なら ALERT にしない', () => {
    const d = evaluate(
      makeInput({ hasApp: false, status: 'WATCH', lastAliveEventAt: minutesAgo(610) }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBeNull();
  });

  it('80%超過で WATCH へ進む', () => {
    const d = evaluate(
      makeInput({ hasApp: false, lastAliveEventAt: minutesAgo(480) }),
      NOW,
      params,
    );
    expect(d.nextStatus).toBe('WATCH');
    expect(d.notifyWatchers).toBe('watch');
  });
});

describe('shouldRenotifyAlert', () => {
  it('未通知なら再通知が必要', () => {
    expect(shouldRenotifyAlert(null, NOW, 24)).toBe(true);
  });

  it('24時間ちょうどで再通知する（境界値）', () => {
    expect(shouldRenotifyAlert(minutesAgo(24 * 60), NOW, 24)).toBe(true);
    expect(shouldRenotifyAlert(minutesAgo(24 * 60 - 1), NOW, 24)).toBe(false);
  });
});

describe('定数の妥当性', () => {
  it('WATCH は閾値の80%', () => {
    expect(WATCH_RATIO).toBe(0.8);
  });
  it('silent push は閾値の50%', () => {
    expect(SILENT_PUSH_RATIO).toBe(0.5);
  });
});
