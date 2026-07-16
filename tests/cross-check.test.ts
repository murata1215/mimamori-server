/**
 * クロス判定の単体テスト（Phase 2, spec 5.2）。
 *
 * 【何を守るテストか】
 * クロス判定は「誤報を減らす仕組み」だが、設計を誤ると
 * 「検知漏れを生む仕組み」に反転する。両側を固定する。
 *
 *   誤報側: スマホの電池が切れただけの元気な親に警告を飛ばさない
 *   漏れ側: 冷蔵庫が回り続けているだけで警告を永久に止めない ← こちらが致命的
 *
 * 後者が壊れると「見守っているつもりで誰も見ていない」状態になる。
 * このサービスで唯一許されない失敗なので、上限に関するテストを厚くする。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  hasFreshWeakSignal,
  type EvaluationInput,
  type EvaluationParams,
} from '../src/engine/state.js';

const params: EvaluationParams = {
  confirmingTimeoutMinutes: 30,
  alertRenotifyHours: 24,
  noAppGraceMinutes: 60,
  weakSignalFreshMinutes: 90,
  crossCheckHoldMinutes: 180,
};

/** 基準時刻 */
const NOW = new Date('2026-07-16T12:00:00+09:00');

/** NOW から遡った時刻を作る */
function minutesAgo(m: number): Date {
  return new Date(NOW.getTime() - m * 60_000);
}

/**
 * 閾値600分（10時間）のクライアントを作る。
 * 既定は「端末沈黙・弱シグナルなし」。
 */
function makeInput(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    status: 'ALIVE',
    lastAliveEventAt: NOW,
    lastHeartbeatAt: NOW,
    confirmingSince: null,
    lastAlertNotifiedAt: null,
    silentPushSentAt: null,
    lastWeakSignalAt: null,
    hasApp: true,
    thresholdMinutes: 600,
    ...overrides,
  };
}

describe('hasFreshWeakSignal', () => {
  it('弱シグナルが一度も無ければ false', () => {
    expect(hasFreshWeakSignal(null, NOW, 90)).toBe(false);
  });

  it('鮮度内なら true', () => {
    expect(hasFreshWeakSignal(minutesAgo(30), NOW, 90)).toBe(true);
  });

  it('鮮度を過ぎていれば false（ソース自体が死んでいる）', () => {
    expect(hasFreshWeakSignal(minutesAgo(120), NOW, 90)).toBe(false);
  });
});

describe('クロス判定 — アプリありクライアント', () => {
  it('【誤報防止】端末沈黙かつ他ソース生存中は CONFIRMING へ進まず WATCH 止まり', () => {
    const d = evaluate(
      makeInput({
        status: 'ALIVE',
        lastAliveEventAt: minutesAgo(700), // 閾値600を超過
        lastHeartbeatAt: minutesAgo(700), // 端末沈黙（45分以上HBなし）
        lastWeakSignalAt: minutesAgo(10), // 他ソースは生きている
      }),
      NOW,
      params,
    );

    expect(d.nextStatus).toBe('WATCH');
    expect(d.reason).toBe('cross_check_hold');
    // 届かない本人確認を送りつけない
    expect(d.notifyClientConfirming).toBe(false);
    expect(d.deviceSilent).toBe(true);
  });

  it('【検知漏れ防止・最重要】保留の上限を超えたら弱シグナルがあってもエスカレーションを再開する', () => {
    // 冷蔵庫が回り続けている家。弱シグナルは永遠に新しいままになりうる。
    const d = evaluate(
      makeInput({
        status: 'ALIVE',
        // 閾値600 + 保留上限180 = 780 を超過
        lastAliveEventAt: minutesAgo(800),
        lastHeartbeatAt: minutesAgo(800),
        lastWeakSignalAt: minutesAgo(1), // ずっと弱シグナルが来ている
      }),
      NOW,
      params,
    );

    // 保留が解けて通常フローへ戻る
    expect(d.nextStatus).toBe('CONFIRMING');
    expect(d.reason).toBe('threshold_exceeded');
  });

  it('端末が生きているならクロス判定は使わない（本人のタップの方が確実）', () => {
    const d = evaluate(
      makeInput({
        status: 'ALIVE',
        lastAliveEventAt: minutesAgo(700),
        lastHeartbeatAt: minutesAgo(5), // 端末は生きている
        lastWeakSignalAt: minutesAgo(10),
      }),
      NOW,
      params,
    );

    expect(d.nextStatus).toBe('CONFIRMING');
    expect(d.notifyClientConfirming).toBe(true);
  });

  it('弱シグナル自体が途絶していれば保留しない', () => {
    const d = evaluate(
      makeInput({
        status: 'ALIVE',
        lastAliveEventAt: minutesAgo(700),
        lastHeartbeatAt: minutesAgo(700),
        lastWeakSignalAt: minutesAgo(200), // 鮮度90分を超過
      }),
      NOW,
      params,
    );

    expect(d.nextStatus).toBe('CONFIRMING');
  });

  it('弱シグナルが一度も無ければ従来どおり（Phase 1 の挙動を壊さない）', () => {
    const d = evaluate(
      makeInput({
        status: 'ALIVE',
        lastAliveEventAt: minutesAgo(700),
        lastHeartbeatAt: minutesAgo(700),
        lastWeakSignalAt: null,
      }),
      NOW,
      params,
    );

    expect(d.nextStatus).toBe('CONFIRMING');
  });

  it('CONFIRMING 中に端末が沈黙し他ソースが生きていれば ALERT を保留する', () => {
    const d = evaluate(
      makeInput({
        status: 'CONFIRMING',
        lastAliveEventAt: minutesAgo(700),
        lastHeartbeatAt: minutesAgo(700),
        confirmingSince: minutesAgo(40), // タイムアウト30分を超過
        lastWeakSignalAt: minutesAgo(10),
      }),
      NOW,
      params,
    );

    expect(d.nextStatus).toBeNull();
    expect(d.reason).toBe('cross_check_hold_confirming');
    // 状態は巻き戻さない（CONFIRMING のまま）
  });

  it('CONFIRMING 中でも保留上限を超えたら ALERT を出す', () => {
    const d = evaluate(
      makeInput({
        status: 'CONFIRMING',
        lastAliveEventAt: minutesAgo(800), // 780 を超過
        lastHeartbeatAt: minutesAgo(800),
        confirmingSince: minutesAgo(40),
        lastWeakSignalAt: minutesAgo(1),
      }),
      NOW,
      params,
    );

    expect(d.nextStatus).toBe('ALERT');
    expect(d.reason).toBe('confirming_timeout');
    // 端末沈黙なので文言は「電池切れの可能性」側になる
    expect(d.deviceSilent).toBe(true);
  });

  it('【重要】既に出した ALERT を弱シグナルで取り下げない', () => {
    const d = evaluate(
      makeInput({
        status: 'ALERT',
        lastAliveEventAt: minutesAgo(700),
        lastHeartbeatAt: minutesAgo(700),
        lastAlertNotifiedAt: minutesAgo(10),
        lastWeakSignalAt: minutesAgo(1), // 保留条件を満たしていても
      }),
      NOW,
      params,
    );

    // ALIVE へも WATCH へも戻さない。解除はウォッチャーの resolve のみ。
    expect(d.nextStatus).toBeNull();
    expect(d.reason).toBe('already_alert');
  });
});

describe('クロス判定 — センサーのみクライアント（has_app=false）', () => {
  it('他ソース生存中は ALERT を保留して WATCH 止まり', () => {
    const d = evaluate(
      makeInput({
        status: 'ALIVE',
        hasApp: false,
        lastHeartbeatAt: null, // 端末が存在しない
        lastAliveEventAt: minutesAgo(700), // 閾値600 + 猶予60 = 660 を超過
        lastWeakSignalAt: minutesAgo(10),
      }),
      NOW,
      params,
    );

    expect(d.nextStatus).toBe('WATCH');
    expect(d.reason).toBe('cross_check_hold');
  });

  it('【検知漏れ防止】保留上限（660+180=840）を超えたら ALERT を出す', () => {
    const d = evaluate(
      makeInput({
        status: 'ALIVE',
        hasApp: false,
        lastHeartbeatAt: null,
        lastAliveEventAt: minutesAgo(900),
        lastWeakSignalAt: minutesAgo(1),
      }),
      NOW,
      params,
    );

    expect(d.nextStatus).toBe('ALERT');
    expect(d.reason).toBe('no_app_threshold_and_grace_exceeded');
    expect(d.notifyWatchers).toBe('alert');
  });

  it('弱シグナルが無ければ従来どおり猶予後 ALERT（Phase 1 の挙動を壊さない）', () => {
    const d = evaluate(
      makeInput({
        status: 'ALIVE',
        hasApp: false,
        lastHeartbeatAt: null,
        lastAliveEventAt: minutesAgo(700),
        lastWeakSignalAt: null,
      }),
      NOW,
      params,
    );

    expect(d.nextStatus).toBe('ALERT');
  });
});
