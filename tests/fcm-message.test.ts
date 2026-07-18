/**
 * FCM メッセージ組み立てのテスト。
 *
 * 【なぜ重要か】
 * iOS は APNs 側の指定が無いと silent(background) push が配信されず、
 * アプリが起きない。ここを取りこぼすと iOS 端末で通知・生存促しが
 * 機能しなくなる（Android だけ動く片肺状態になる）。
 */
import { describe, expect, it } from 'vitest';
import { buildFcmMessage, type PushRequest } from '../src/notify/fcm.js';

function makeReq(overrides: Partial<PushRequest> = {}): PushRequest {
  return {
    token: 'token-abc',
    kind: 'watch',
    title: 'タイトル',
    body: '本文',
    ...overrides,
  };
}

// 型を緩めて中身を検査するヘルパー
function asObj(v: unknown): Record<string, unknown> {
  return v as Record<string, unknown>;
}

describe('buildFcmMessage', () => {
  it('全ての kind で apns フィールドを含む（iOS 配信のため）', () => {
    const kinds: PushRequest['kind'][] = [
      'confirming',
      'watch',
      'alert',
      'sos',
      'permission',
      'outage',
      'silent',
      'stamp',
    ];
    for (const kind of kinds) {
      const msg = buildFcmMessage(makeReq({ kind }));
      expect(msg.apns, `kind=${kind}`).toBeDefined();
      const apns = asObj(msg.apns);
      expect(apns.headers).toBeDefined();
      expect(asObj(apns.payload).aps).toBeDefined();
    }
  });

  it('silent は data-only + background push（notification なし・content-available:1）', () => {
    const msg = buildFcmMessage(makeReq({ kind: 'silent' }));

    // notification を含めてはならない（通知が表示されてしまう）
    expect(msg.notification).toBeUndefined();

    const apns = asObj(msg.apns);
    // background push は apns-priority 5 が必須
    expect(asObj(apns.headers)['apns-priority']).toBe('5');

    const aps = asObj(asObj(apns.payload).aps);
    expect(aps['content-available']).toBe(1);
    // background push に alert/sound を混ぜない
    expect(aps.sound).toBeUndefined();
    expect(aps.alert).toBeUndefined();

    // Android 側は high priority のまま
    expect(asObj(msg.android).priority).toBe('high');
  });

  it('alert/sos は高優先（apns-priority 10 + sound）で notification を含む', () => {
    for (const kind of ['alert', 'sos', 'confirming'] as const) {
      const msg = buildFcmMessage(makeReq({ kind }));
      const apns = asObj(msg.apns);
      expect(asObj(apns.headers)['apns-priority'], `kind=${kind}`).toBe('10');
      expect(asObj(asObj(apns.payload).aps).sound, `kind=${kind}`).toBe('default');
      expect(msg.notification, `kind=${kind}`).toEqual({ title: 'タイトル', body: '本文' });
      expect(asObj(msg.android).priority).toBe('high');
    }
  });

  it('watch/permission/outage/stamp は通常優先（apns-priority 5・sound なし）', () => {
    for (const kind of ['watch', 'permission', 'outage', 'stamp'] as const) {
      const msg = buildFcmMessage(makeReq({ kind }));
      const apns = asObj(msg.apns);
      expect(asObj(apns.headers)['apns-priority'], `kind=${kind}`).toBe('5');
      expect(asObj(asObj(apns.payload).aps).sound, `kind=${kind}`).toBeUndefined();
      expect(msg.notification, `kind=${kind}`).toBeDefined();
      expect(asObj(msg.android).priority).toBe('normal');
    }
  });

  it('data payload に kind を必ず含める', () => {
    const msg = buildFcmMessage(makeReq({ kind: 'sos', data: { incident_id: 'x1' } }));
    expect(msg.data).toEqual({ kind: 'sos', incident_id: 'x1' });
  });
});
