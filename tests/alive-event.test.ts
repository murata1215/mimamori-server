/**
 * 生存イベント判定のテスト。
 *
 * 【この判定がプロダクトの根幹】
 * 「端末が生きている」と「本人が生きている」の区別（spec 5.1）。
 * ここを間違えると、充電器に挿さったまま持ち主が倒れている端末を
 * 「生存」と誤判定する — つまりプロダクトが存在意義を失う。
 */
import { describe, expect, it } from 'vitest';
import { isAliveEvent, isWeakSignal, type IngestEvent } from '../src/engine/events.js';

/** テスト用イベントを作る */
function makeEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    clientId: '00000000-0000-0000-0000-000000000001',
    sourceType: 'phone',
    eventType: 'heartbeat',
    occurredAt: new Date(),
    ...overrides,
  };
}

describe('isAliveEvent — heartbeat の扱い', () => {
  it('スクリーンONがあれば生存イベント', () => {
    expect(isAliveEvent(makeEvent({ meta: { screen_on_count: 3 } }))).toBe(true);
  });

  it('アプリ利用があれば生存イベント', () => {
    expect(isAliveEvent(makeEvent({ meta: { had_app_usage: true } }))).toBe(true);
  });

  it('【最重要】操作が全く無いheartbeatは生存イベントではない', () => {
    // 端末は生きているが本人の操作がない状態。
    // これを生存扱いすると、充電器に挿さった端末が持ち主の生存を
    // 偽装し続けることになる。
    expect(
      isAliveEvent(makeEvent({ meta: { screen_on_count: 0, had_app_usage: false, battery_level: 80 } })),
    ).toBe(false);
  });

  it('meta が空のheartbeatは生存イベントではない', () => {
    expect(isAliveEvent(makeEvent({ meta: {} }))).toBe(false);
    expect(isAliveEvent(makeEvent({}))).toBe(false);
  });

  it('had_app_usage が false 相当の値でも生存扱いしない', () => {
    // 'false' という文字列を true と誤解しないこと
    expect(isAliveEvent(makeEvent({ meta: { had_app_usage: 'false' } }))).toBe(false);
    expect(isAliveEvent(makeEvent({ meta: { had_app_usage: 0 } }))).toBe(false);
  });
});

describe('isAliveEvent — その他のイベント種別', () => {
  it('activity は既定（confidence 100）なら生存イベント（センサー由来の生活反応）', () => {
    expect(isAliveEvent(makeEvent({ eventType: 'activity' }))).toBe(true);
  });

  it('confirm_alive は常に生存イベント（本人がタップした）', () => {
    expect(isAliveEvent(makeEvent({ eventType: 'confirm_alive' }))).toBe(true);
  });

  it('【重要】sos は生存イベントではない', () => {
    // SOSで ALIVE へ復帰させてはならない。
    // SOSは本人の異常申告であり、生存の証明ではない。
    expect(isAliveEvent(makeEvent({ eventType: 'sos' }))).toBe(false);
  });

  it('source_silent は生存イベントではない', () => {
    expect(isAliveEvent(makeEvent({ eventType: 'source_silent' }))).toBe(false);
  });
});

describe('isAliveEvent — confidence による強弱の区別（Phase 2）', () => {
  /**
   * 【このテスト群が守っているもの】
   * spec 8 は電力メーターを「confidence 70程度の低信頼ソース」と定める。
   * もし低信頼の activity が生存イベントとして経過時間をリセットすると、
   * 冷蔵庫のコンプレッサーが住人の死後も回り続けて「生存」を証明し続け、
   * デッドマンスイッチが二度と発報しなくなる。
   *
   * 誤報より遥かに悪い失敗であり、ここが緑であることが
   * Phase 2 でセンサーを増やしても安全である根拠になる。
   */
  it('【最重要】低信頼ソース(confidence 70)の activity は生存イベントではない', () => {
    expect(isAliveEvent(makeEvent({ eventType: 'activity', confidence: 70 }))).toBe(false);
  });

  it('高信頼ソース(confidence 100)の activity は生存イベント', () => {
    expect(isAliveEvent(makeEvent({ eventType: 'activity', confidence: 100 }))).toBe(true);
  });

  it('境界値: confidence 80 は生存イベント（HIGH_CONFIDENCE_MIN 以上）', () => {
    expect(isAliveEvent(makeEvent({ eventType: 'activity', confidence: 80 }))).toBe(true);
  });

  it('境界値: confidence 79 は生存イベントではない', () => {
    expect(isAliveEvent(makeEvent({ eventType: 'activity', confidence: 79 }))).toBe(false);
  });

  it('confirm_alive は confidence に関わらず生存イベント（本人が押した事実は揺るがない）', () => {
    expect(isAliveEvent(makeEvent({ eventType: 'confirm_alive', confidence: 0 }))).toBe(true);
  });

  it('低信頼の activity は弱シグナルとして識別される', () => {
    expect(isWeakSignal(makeEvent({ eventType: 'activity', confidence: 70 }))).toBe(true);
  });

  it('高信頼の activity は弱シグナルではない', () => {
    expect(isWeakSignal(makeEvent({ eventType: 'activity', confidence: 100 }))).toBe(false);
  });

  it('heartbeat は弱シグナルではない（別系統の判定材料）', () => {
    expect(isWeakSignal(makeEvent({ eventType: 'heartbeat', confidence: 0 }))).toBe(false);
  });
});
