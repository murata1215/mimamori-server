/**
 * デッドマンスイッチの統合テスト（実DB使用）。
 *
 * 【なぜ統合テストが必要か】
 * state.test.ts は判定ロジックを純粋関数として検証しているが、
 * それだけでは「実際に時間が経過したらALERTが飛ぶ」ことを保証できない。
 * DBの非正規化カラム更新・状態遷移の永続化・生存イベントによる復帰が
 * 噛み合って初めて見守りが成立する。
 *
 * このテストが落ちる = 孤独死を検知できない、ということ。
 *
 * 前提: DATABASE_URL のDBにマイグレーション済みであること。
 * テストデータは各テストの前後で自分の分だけ削除する。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../src/db/pool.js';
import { ingestEvents } from '../src/engine/events.js';
import { runEvaluation } from '../src/engine/evaluator.js';
import { setFcmDriver, type FcmDriver, type PushRequest } from '../src/notify/fcm.js';

/** 送信された通知を記録するテスト用ドライバ */
class RecordingFcmDriver implements FcmDriver {
  public sent: PushRequest[] = [];
  async send(req: PushRequest) {
    this.sent.push(req);
    return { ok: true };
  }
  reset() {
    this.sent = [];
  }
}

const fcm = new RecordingFcmDriver();
setFcmDriver(fcm);

let clientId: string;
let watcherId: string;

/**
 * テスト用のクライアントとウォッチャーを作る。
 *
 * @param thresholdMinutes - 閾値（分）
 * @param hasApp - アプリを持つか
 */
async function createClient(thresholdMinutes = 600, hasApp = true): Promise<void> {
  const w = await query<{ id: string }>(
    `INSERT INTO watchers (display_name, email, password_hash, fcm_token)
     VALUES ('テスト見守り', $1, 'x', 'watcher-token') RETURNING id`,
    [`test-${Date.now()}-${Math.round(Math.random() * 1e9)}@example.test`],
  );
  watcherId = w.rows[0]!.id;

  const c = await query<{ id: string }>(
    `INSERT INTO clients (display_name, threshold_minutes, has_app, last_alive_event_at,
                          last_heartbeat_at, status, status_changed_at, consent_version, consent_at)
     VALUES ('テスト対象', $1, $2, now(), now(), 'ALIVE', now(), 'v1.0', now())
     RETURNING id`,
    [thresholdMinutes, hasApp],
  );
  clientId = c.rows[0]!.id;

  await query('INSERT INTO watch_links (watcher_id, client_id) VALUES ($1, $2)', [
    watcherId,
    clientId,
  ]);
  await query(
    `INSERT INTO devices (client_id, platform, fcm_token, last_seen_at)
     VALUES ($1, 'android', 'device-token', now())`,
    [clientId],
  );
}

/**
 * 最終生存イベント時刻を過去へずらす（時間経過のシミュレーション）。
 *
 * @param minutes - 何分前にするか
 * @param alsoHeartbeat - ハートビート時刻も同様にずらすか（端末沈黙の再現）
 */
async function backdate(minutes: number, alsoHeartbeat = false): Promise<void> {
  await query(
    `UPDATE clients
        SET last_alive_event_at = now() - ($2 || ' minutes')::interval
            ${alsoHeartbeat ? ", last_heartbeat_at = now() - ($2 || ' minutes')::interval" : ''}
      WHERE id = $1`,
    [clientId, minutes],
  );
}

/** 現在の状態を取得する */
async function statusOf(): Promise<string> {
  const res = await query<{ status: string }>('SELECT status FROM clients WHERE id = $1', [
    clientId,
  ]);
  return res.rows[0]!.status;
}

/** CONFIRMING 開始時刻を過去へずらす（無応答タイムアウトの再現） */
async function backdateConfirming(minutes: number): Promise<void> {
  await query(
    `UPDATE clients SET confirming_since = now() - ($2 || ' minutes')::interval WHERE id = $1`,
    [clientId, minutes],
  );
}

beforeEach(async () => {
  fcm.reset();
  await createClient();
});

afterEach(async () => {
  // 自分が作ったデータだけを消す
  if (clientId) {
    await query('DELETE FROM events WHERE client_id = $1', [clientId]);
    await query('DELETE FROM audit_log WHERE client_id = $1', [clientId]);
    await query('DELETE FROM clients WHERE id = $1', [clientId]);
  }
  if (watcherId) await query('DELETE FROM watchers WHERE id = $1', [watcherId]);
});

afterAll(async () => {
  await closePool();
});

describe('デッドマンスイッチ — 完全な検知シーケンス', () => {
  it('閾値内は ALIVE のまま、誰にも通知しない', async () => {
    await backdate(100);
    await runEvaluation();
    expect(await statusOf()).toBe('ALIVE');
    expect(fcm.sent).toHaveLength(0);
  });

  it('80%経過で WATCH になりウォッチャーへ通知が飛ぶ', async () => {
    await backdate(480);
    await runEvaluation();
    expect(await statusOf()).toBe('WATCH');
    const watchPush = fcm.sent.find((s) => s.kind === 'watch');
    expect(watchPush).toBeDefined();
    expect(watchPush!.token).toBe('watcher-token');
  });

  it('閾値超過で CONFIRMING になり、クライアント端末へ全画面通知が飛ぶ', async () => {
    await backdate(610);
    await runEvaluation();
    expect(await statusOf()).toBe('CONFIRMING');

    const confirmPush = fcm.sent.find((s) => s.kind === 'confirming');
    expect(confirmPush).toBeDefined();
    expect(confirmPush!.token).toBe('device-token');

    // 【重要】この時点でウォッチャーへ通知してはならない
    expect(fcm.sent.find((s) => s.token === 'watcher-token')).toBeUndefined();
  });

  it('【本丸】CONFIRMING が30分無応答なら ALERT になりウォッチャーへ通知が飛ぶ', async () => {
    await backdate(610);
    await runEvaluation();
    expect(await statusOf()).toBe('CONFIRMING');

    fcm.reset();
    await backdateConfirming(31);
    await runEvaluation();

    expect(await statusOf()).toBe('ALERT');
    const alertPush = fcm.sent.find((s) => s.kind === 'alert');
    expect(alertPush).toBeDefined();
    expect(alertPush!.token).toBe('watcher-token');
  });

  it('本人確認へ応答すれば ALERT に至らず即 ALIVE へ復帰する（誤報の逃げ道）', async () => {
    await backdate(610);
    await runEvaluation();
    expect(await statusOf()).toBe('CONFIRMING');

    // 本人がタップ
    await ingestEvents([
      {
        clientId,
        sourceType: 'phone',
        eventType: 'confirm_alive',
        occurredAt: new Date(),
      },
    ]);

    expect(await statusOf()).toBe('ALIVE');

    // 30分経ってもALERTにならない（confirming_since がクリアされている）
    fcm.reset();
    await runEvaluation();
    expect(await statusOf()).toBe('ALIVE');
    expect(fcm.sent.find((s) => s.kind === 'alert')).toBeUndefined();
  });
});

describe('デッドマンスイッチ — 生存イベントによる復帰', () => {
  it('操作ありハートビートで WATCH から即 ALIVE へ復帰する', async () => {
    await backdate(480);
    await runEvaluation();
    expect(await statusOf()).toBe('WATCH');

    await ingestEvents([
      {
        clientId,
        sourceType: 'phone',
        eventType: 'heartbeat',
        occurredAt: new Date(),
        meta: { screen_on_count: 2, had_app_usage: true },
      },
    ]);

    expect(await statusOf()).toBe('ALIVE');
  });

  it('【最重要】操作なしハートビートでは復帰しない（端末は生きているが本人は不明）', async () => {
    await backdate(480);
    await runEvaluation();
    expect(await statusOf()).toBe('WATCH');

    // 充電器に挿さったまま、誰も触っていない端末からのハートビート
    await ingestEvents([
      {
        clientId,
        sourceType: 'phone',
        eventType: 'heartbeat',
        occurredAt: new Date(),
        meta: { screen_on_count: 0, had_app_usage: false, battery_level: 100 },
      },
    ]);

    // WATCH のまま。これが守れないとプロダクトが存在意義を失う。
    expect(await statusOf()).toBe('WATCH');
  });

  it('復帰時に confirming_since / silent_push_sent_at がクリアされる', async () => {
    await backdate(610);
    await runEvaluation();

    await ingestEvents([
      {
        clientId,
        sourceType: 'phone',
        eventType: 'confirm_alive',
        occurredAt: new Date(),
      },
    ]);

    const res = await query<{
      confirming_since: Date | null;
      silent_push_sent_at: Date | null;
      last_alert_notified_at: Date | null;
    }>(
      'SELECT confirming_since, silent_push_sent_at, last_alert_notified_at FROM clients WHERE id = $1',
      [clientId],
    );
    const row = res.rows[0]!;
    // これらが残っていると、次にCONFIRMINGへ入った瞬間にALERTへ飛ぶ
    expect(row.confirming_since).toBeNull();
    expect(row.silent_push_sent_at).toBeNull();
    expect(row.last_alert_notified_at).toBeNull();
  });
});

describe('デッドマンスイッチ — silent push', () => {
  it('閾値の50%で silent push が送られ、二度は送られない', async () => {
    await backdate(320);
    await runEvaluation();

    const silent = fcm.sent.filter((s) => s.kind === 'silent');
    expect(silent).toHaveLength(1);
    expect(silent[0]!.token).toBe('device-token');

    // 二度目の判定では再送しない
    fcm.reset();
    await runEvaluation();
    expect(fcm.sent.filter((s) => s.kind === 'silent')).toHaveLength(0);
  });
});

describe('デッドマンスイッチ — 端末沈黙の区別', () => {
  it('端末沈黙時の ALERT は文言に電池切れの可能性を含む', async () => {
    // 生存イベントもハートビートも途絶している = 端末が死んでいる
    await backdate(610, true);
    await runEvaluation();
    await backdateConfirming(31);
    fcm.reset();
    await runEvaluation();

    expect(await statusOf()).toBe('ALERT');
    const alertPush = fcm.sent.find((s) => s.kind === 'alert');
    expect(alertPush).toBeDefined();
    expect(alertPush!.body).toContain('電池切れ');
    expect(alertPush!.data?.device_silent).toBe('true');
  });

  it('端末生存・操作なしの ALERT は断定的な文言になる', async () => {
    // ハートビートは届いているが操作がない
    await backdate(610, false);
    await runEvaluation();
    await backdateConfirming(31);
    fcm.reset();
    await runEvaluation();

    const alertPush = fcm.sent.find((s) => s.kind === 'alert');
    expect(alertPush!.body).not.toContain('電池切れ');
    expect(alertPush!.data?.device_silent).toBe('false');
  });
});

describe('デッドマンスイッチ — 監査ログ（免責の証跡）', () => {
  it('全ての状態遷移が audit_log に記録される', async () => {
    await backdate(610);
    await runEvaluation();
    await backdateConfirming(31);
    await runEvaluation();

    const res = await query<{ event: string; detail: Record<string, unknown> }>(
      `SELECT event, detail FROM audit_log
        WHERE client_id = $1 AND event = 'status_change'
        ORDER BY created_at`,
      [clientId],
    );

    const transitions = res.rows.map((r) => `${r.detail.from}->${r.detail.to}`);
    expect(transitions).toContain('ALIVE->CONFIRMING');
    expect(transitions).toContain('CONFIRMING->ALERT');
  });

  it('通知の送信結果が audit_log に記録される', async () => {
    await backdate(610);
    await runEvaluation();

    const res = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_log
        WHERE client_id = $1 AND event = 'notification_sent'`,
      [clientId],
    );
    expect(res.rows[0]!.count).toBeGreaterThan(0);
  });

  it('【位置情報の隔離】audit_log に座標が入らない', async () => {
    await backdate(610);
    await runEvaluation();

    const res = await query<{ detail: string }>(
      `SELECT detail::text AS detail FROM audit_log WHERE client_id = $1`,
      [clientId],
    );
    for (const row of res.rows) {
      expect(row.detail).not.toMatch(/latitude|longitude|"lat"|"lng"/);
    }
  });
});
