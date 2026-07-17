/**
 * 通知ディスパッチャ。
 *
 * 「誰に・どの状態で・何を送るか」を一箇所に集約する（spec 5.4 の表の実装）。
 *
 * | 遷移        | クライアントへ       | ウォッチャーへ                    |
 * |------------|--------------------|----------------------------------|
 * | → WATCH    | なし                | 通常push（watcher設定でOFF可）     |
 * | → CONFIRMING| 全画面通知(high)   | なし                             |
 * | → ALERT    | なし                | 全画面push＋(owner)SMS            |
 * | SOS        | 発動確認画面        | 全画面push＋SMS。data に incident_id |
 * | 権限失効    | なし                | 「設定に問題」push                 |
 *
 * 全ての送信結果は audit_log に記録する（免責の証跡）。
 *
 * 【data payload の client_name】(flutter 連携 2026-07-17)
 * ウォッチャー宛の kind（watch / alert / sos / permission）には、
 * クライアントの display_name を client_name として載せる。
 * ウォッチャー端末がオフライン・起動直後でも、API照会なしに
 * 「誰の」通知かを表示できるようにするため。
 * この値は既に通知 body（「◯◯さんの…」）に含まれる情報であり、
 * 開示レベルは変わらない（原則2に抵触しない）。
 *
 * outage は特定クライアントに紐づかない全ウォッチャー宛の
 * サービス停止通知のため、client_name も client_id も持たない。
 * クライアント端末宛の confirming / silent にも client_name は不要。
 */
import { query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { sendWithRetry, type PushKind } from './fcm.js';
import { sendSms } from './sms.js';

/** 通知先ウォッチャーの情報 */
interface WatcherTarget {
  id: string;
  display_name: string;
  fcm_token: string | null;
  phone_number: string | null;
  plan: string;
  notify_watch: boolean;
}

/**
 * クライアントに紐づく全ウォッチャーを取得する。
 *
 * @param clientId - クライアントID
 * @returns ウォッチャー一覧
 */
async function getWatchersFor(clientId: string): Promise<WatcherTarget[]> {
  const res = await query<WatcherTarget>(
    `SELECT w.id, w.display_name, w.fcm_token, w.phone_number, w.plan, w.notify_watch
       FROM watchers w
       JOIN watch_links l ON l.watcher_id = w.id
      WHERE l.client_id = $1`,
    [clientId],
  );
  return res.rows;
}

/**
 * クライアントの表示名を取得する。
 *
 * @param clientId - クライアントID
 * @returns 表示名（見つからなければ 'ご家族'）
 */
async function getClientName(clientId: string): Promise<string> {
  const res = await query<{ display_name: string }>(
    'SELECT display_name FROM clients WHERE id = $1',
    [clientId],
  );
  return res.rows[0]?.display_name ?? 'ご家族';
}

/**
 * 通知文言の出し分けに必要なクライアント情報を取得する。
 *
 * @param clientId - クライアントID
 * @returns 表示名とプロファイル
 */
async function getClientProfile(clientId: string): Promise<{ name: string; hasApp: boolean }> {
  const res = await query<{ display_name: string; has_app: boolean }>(
    'SELECT display_name, has_app FROM clients WHERE id = $1',
    [clientId],
  );
  const row = res.rows[0];
  return { name: row?.display_name ?? 'ご家族', hasApp: row?.has_app ?? true };
}

/**
 * ALERT の本文を組み立てる。
 *
 * 【この関数の責務は「断定しないこと」】
 * サーバーが知っているのは「一定時間シグナルが来ていない」という事実だけで、
 * 本人に何が起きたかは分からない。分からないことを分かったように書くと、
 * 空振りのたびにウォッチャーの信頼が削れ、やがて通知を無視するようになる
 * （狼少年化）。そうなった時点で見守りは死ぬ。
 * したがって文言は、観測できた事実と、その事実に対する別解釈を必ず併記する。
 *
 * @param name - クライアントの表示名
 * @param hasApp - アプリを持つクライアントか
 * @param deviceSilent - 端末沈黙中か
 * @returns 通知本文
 */
function buildAlertBody(name: string, hasApp: boolean, deviceSilent: boolean): string {
  // センサーのみクライアント: 沈黙の原因が「本人の異常」か「センサーの不具合」かを
  // 原理的に区別できない（本人に問い合わせる手段が無いため）。両方を併記する。
  if (!hasApp) {
    return `${name}さんのセンサーから反応がありません。センサーの不具合の可能性もあります。確認してください。`;
  }

  // 端末沈黙時は「本人の異常」と断定できない。電池切れ・電源OFFの可能性を明示する
  // （spec 5.2）。
  if (deviceSilent) {
    return `${name}さんの端末から信号が途絶えています。電池切れ・電源OFFの可能性もあります。確認してください。`;
  }

  // 端末は生きているのに本人確認へ応答がない = 最も本人の異常が疑われるケース。
  return `${name}さんの安否確認が取れません。確認してください。`;
}

/**
 * 無効になったFCMトークンをDBから消す。
 *
 * 無効トークンを残すと毎回送信失敗し、audit_log がノイズで埋まる。
 *
 * @param table - 'watchers' | 'devices'
 * @param id - 対象ID
 */
async function clearInvalidToken(table: 'watchers' | 'devices', id: string): Promise<void> {
  // table は内部呼び出しのリテラルのみ。外部入力を渡してはならない。
  await query(`UPDATE ${table} SET fcm_token = NULL WHERE id = $1`, [id]);
}

/**
 * ウォッチャー1人へプッシュを送り、結果を監査ログに記録する。
 *
 * @param clientId - 対象クライアントID
 * @param watcher - 送信先ウォッチャー
 * @param kind - 通知種別
 * @param title - 通知タイトル
 * @param body - 通知本文
 * @param data - data payload
 */
async function pushToWatcher(
  clientId: string,
  watcher: WatcherTarget,
  kind: PushKind,
  title: string,
  body: string,
  data: Record<string, string> = {},
): Promise<boolean> {
  if (!watcher.fcm_token) {
    await audit(clientId, 'notification_failed', {
      target: 'watcher',
      watcher_id: watcher.id,
      kind,
      reason: 'no_fcm_token',
    });
    return false;
  }

  const result = await sendWithRetry({
    token: watcher.fcm_token,
    kind,
    title,
    body,
    data: { client_id: clientId, ...data },
  });

  if (result.ok) {
    await audit(clientId, 'notification_sent', {
      target: 'watcher',
      watcher_id: watcher.id,
      kind,
    });
    return true;
  }

  await audit(clientId, 'notification_failed', {
    target: 'watcher',
    watcher_id: watcher.id,
    kind,
    error: result.error,
    invalid_token: result.invalidToken ?? false,
  });

  if (result.invalidToken) await clearInvalidToken('watchers', watcher.id);
  return false;
}

/**
 * WATCH（注視）への遷移をウォッチャーへ通知する。
 *
 * notify_watch = false のウォッチャーには送らない（設定でOFF可能）。
 *
 * @param clientId - クライアントID
 */
export async function notifyWatch(clientId: string): Promise<void> {
  const [watchers, name] = await Promise.all([getWatchersFor(clientId), getClientName(clientId)]);

  for (const w of watchers) {
    if (!w.notify_watch) continue;
    await pushToWatcher(
      clientId,
      w,
      'watch',
      '見守りのお知らせ',
      `${name}さんの様子をしばらく確認できていません。`,
      { status: 'WATCH', client_name: name },
    );
  }
}

/**
 * ALERT（警告）をウォッチャーへ通知する。
 *
 * ownerプランのウォッチャーにはSMSフォールバックも行う。
 * 限界費用が発生する機能は有料側に置く原則（spec 5 課金設計）。
 *
 * @param clientId - クライアントID
 * @param deviceSilent - 端末沈黙中か。文言を変える。
 */
export async function notifyAlert(clientId: string, deviceSilent: boolean): Promise<void> {
  const [watchers, profile] = await Promise.all([
    getWatchersFor(clientId),
    getClientProfile(clientId),
  ]);

  const body = buildAlertBody(profile.name, profile.hasApp, deviceSilent);

  for (const w of watchers) {
    const pushed = await pushToWatcher(clientId, w, 'alert', '⚠️ 警告', body, {
      status: 'ALERT',
      client_name: profile.name,
      device_silent: String(deviceSilent),
    });

    // ownerプランはSMSフォールバック。
    // プッシュが成功していても、ALERTは見逃しが許されないため送る。
    if (w.plan === 'owner' && w.phone_number) {
      const smsResult = await sendSms(w.phone_number, `【mimamori】${body}`);
      await audit(clientId, smsResult.ok ? 'notification_sent' : 'notification_failed', {
        target: 'watcher',
        watcher_id: w.id,
        kind: 'alert',
        channel: 'sms',
        push_succeeded: pushed,
        ...(smsResult.ok ? {} : { error: smsResult.error }),
      });
    }
  }

  // ALERT通知時刻を記録（24h周期の再通知判定に使う）
  await query('UPDATE clients SET last_alert_notified_at = now() WHERE id = $1', [clientId]);
}

/**
 * SOS をウォッチャーへ通知する（最強通知）。
 *
 * SOSは判定ジョブを介さない同期パス。data payload に incident_id を載せ、
 * クライアントアプリが地図画面へ直行できるようにする。
 *
 * @param clientId - クライアントID
 * @param incidentId - SOSインシデントID
 */
export async function notifySos(clientId: string, incidentId: string): Promise<void> {
  const [watchers, name] = await Promise.all([getWatchersFor(clientId), getClientName(clientId)]);
  const body = `${name}さんがSOSを発動しました。すぐに確認してください。`;

  for (const w of watchers) {
    await pushToWatcher(clientId, w, 'sos', '🆘 SOS', body, {
      status: 'SOS',
      client_name: name,
      incident_id: incidentId,
    });

    // SOSのSMSはownerプランのみ（限界費用の隔離原則）
    if (w.plan === 'owner' && w.phone_number) {
      const smsResult = await sendSms(w.phone_number, `【mimamori】${body}`);
      await audit(clientId, smsResult.ok ? 'notification_sent' : 'notification_failed', {
        target: 'watcher',
        watcher_id: w.id,
        kind: 'sos',
        channel: 'sms',
        ...(smsResult.ok ? {} : { error: smsResult.error }),
      });
    }
  }
}

/**
 * 「設定に問題」をウォッチャーへ通知する。
 *
 * 権限失効・長期沈黙時。ウォッチャー側UIは灰色バッジになる。
 *
 * @param clientId - クライアントID
 * @param reason - 問題の内容（ウォッチャーには詳細を出さないが監査には残す）
 */
export async function notifyPermissionIssue(clientId: string, reason: string): Promise<void> {
  const [watchers, name] = await Promise.all([getWatchersFor(clientId), getClientName(clientId)]);

  for (const w of watchers) {
    await pushToWatcher(
      clientId,
      w,
      'permission',
      '設定に問題があります',
      `${name}さんの端末から信号が届いていません（電池切れ/設定の可能性）。`,
      { status: 'PERMISSION_ISSUE', client_name: name, reason },
    );
  }
}

/**
 * クライアント端末へ本人確認（CONFIRMING）の全画面通知を送る。
 *
 * これが「警告の前の逃げ道」。タップ1つで解除でき、誤報を警告に育てない。
 * 本人確認解除率90%以上がKPI（=警告前に誤報が止まっている）。
 *
 * @param clientId - クライアントID
 */
export async function notifyClientConfirming(clientId: string): Promise<void> {
  const [devices, name] = await Promise.all([
    query<{ id: string; fcm_token: string | null }>(
      'SELECT id, fcm_token FROM devices WHERE client_id = $1 AND fcm_token IS NOT NULL',
      [clientId],
    ),
    getClientName(clientId),
  ]);

  if (devices.rows.length === 0) {
    await audit(clientId, 'notification_failed', {
      target: 'client',
      kind: 'confirming',
      reason: 'no_device_token',
    });
    return;
  }

  for (const d of devices.rows) {
    const result = await sendWithRetry({
      token: d.fcm_token!,
      kind: 'confirming',
      title: `${name}さん、無事ですか？`,
      body: 'タップしてお知らせください',
      data: { client_id: clientId },
    });

    await audit(clientId, result.ok ? 'notification_sent' : 'notification_failed', {
      target: 'client',
      device_id: d.id,
      kind: 'confirming',
      ...(result.ok ? {} : { error: result.error }),
    });

    if (result.invalidToken) await clearInvalidToken('devices', d.id);
  }
}

/**
 * クライアント端末へ silent push を送り、ハートビートを促す。
 *
 * WorkManagerがOEMのタスクキラーに殺されている端末を叩き起こす補助経路
 * （flutter spec 3.2）。通知は表示されない。
 *
 * @param clientId - クライアントID
 */
export async function sendSilentPush(clientId: string): Promise<void> {
  const devices = await query<{ id: string; fcm_token: string | null }>(
    'SELECT id, fcm_token FROM devices WHERE client_id = $1 AND fcm_token IS NOT NULL',
    [clientId],
  );

  for (const d of devices.rows) {
    const result = await sendWithRetry({
      token: d.fcm_token!,
      kind: 'silent',
      data: { action: 'heartbeat_now' },
    });
    if (result.invalidToken) await clearInvalidToken('devices', d.id);
  }

  await audit(clientId, 'silent_push_sent', { devices: devices.rows.length });
}

/**
 * サービス停止をウォッチャーへ正直に通知する。
 *
 * 「サーバー停止が閾値超過時間に及んだ場合、復旧時に『監視が◯時間停止していました』を
 * 全ウォッチャーへ正直に通知する（信頼の担保。黙って再開しない）」(spec 7)。
 *
 * @param gapMinutes - 停止していた時間（分）
 */
export async function notifyServiceOutage(gapMinutes: number): Promise<void> {
  const hours = (gapMinutes / 60).toFixed(1);
  const res = await query<{ id: string; fcm_token: string | null }>(
    'SELECT id, fcm_token FROM watchers WHERE fcm_token IS NOT NULL',
  );

  for (const w of res.rows) {
    const result = await sendWithRetry({
      token: w.fcm_token!,
      kind: 'outage',
      title: '見守りの一時停止について',
      body: `システムの都合により、見守りが約${hours}時間停止していました。現在は復旧しています。`,
      data: { gap_minutes: String(gapMinutes) },
    });
    if (result.invalidToken) await clearInvalidToken('watchers', w.id);
  }

  await audit(null, 'service_outage', { gap_minutes: gapMinutes, notified: res.rows.length });
}

/**
 * クライアントからのスタンプを全ウォッチャーへ通知する。
 *
 * @param clientId - クライアントID
 * @param stamp - スタンプコード（'fine', 'not_well', 'bad' 等）
 * @param clientName - クライアントの表示名
 */
export async function notifyStampToWatchers(
  clientId: string,
  stamp: string,
  clientName: string,
): Promise<void> {
  const watchers = await getWatchersFor(clientId);
  for (const w of watchers) {
    await pushToWatcher(clientId, w, 'stamp', 'スタンプ', `${clientName}さんからスタンプが届きました`, {
      stamp,
      client_name: clientName,
      direction: 'from_client',
    });
  }
}

/**
 * ウォッチャーからのスタンプをクライアントの全デバイスへ通知する。
 *
 * @param clientId - クライアントID
 * @param stamp - スタンプコード
 * @param senderName - ウォッチャーの表示名
 */
export async function notifyStampToClient(
  clientId: string,
  stamp: string,
  senderName: string,
): Promise<void> {
  const devices = await query<{ id: string; fcm_token: string | null }>(
    'SELECT id, fcm_token FROM devices WHERE client_id = $1 AND fcm_token IS NOT NULL',
    [clientId],
  );

  for (const d of devices.rows) {
    const result = await sendWithRetry({
      token: d.fcm_token!,
      kind: 'stamp',
      title: 'スタンプ',
      body: `${senderName}さんからスタンプが届きました`,
      data: { stamp, sender_name: senderName, direction: 'from_watcher' },
    });
    if (result.invalidToken) await clearInvalidToken('devices', d.id);
  }
}
