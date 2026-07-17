/**
 * FCM（Firebase Cloud Messaging）送信アダプタ。
 *
 * 【設計方針】
 * Firebase の認証情報が未設定でもサーバーは起動し、判定エンジンは動作する。
 * 未設定時は no-op ドライバ（ログ出力のみ）にフォールバックする。
 * これは開発・テスト環境のためであり、本番で認証情報が無い場合は
 * 起動時に警告を出し続ける（通知できない見守りサービスは無意味なため）。
 *
 * firebase-admin は重いので動的 import で遅延ロードする。
 */
import { config } from '../config.js';

/** 送信するメッセージの種別。ペイロード設計はクライアント仕様と対で決まる。 */
export type PushKind =
  | 'confirming'      // クライアントへ: 全画面通知「無事ですか？」
  | 'watch'           // ウォッチャーへ: 静かな通知
  | 'alert'           // ウォッチャーへ: 全画面push＋アラーム音
  | 'sos'             // ウォッチャーへ: 最強通知＋位置情報画面
  | 'permission'      // ウォッチャーへ: 「設定に問題」
  | 'outage'          // ウォッチャーへ: 監視停止のお知らせ
  | 'silent'          // クライアントへ: data-only。端末を起こしてハートビートを促す
  | 'stamp';          // 双方向: スタンプ送受信

/** 送信リクエスト */
export interface PushRequest {
  token: string;
  kind: PushKind;
  title?: string;
  body?: string;
  /** data payload。文字列値のみ（FCMの制約） */
  data?: Record<string, string>;
}

/** 送信結果 */
export interface PushResult {
  ok: boolean;
  /** 送信先トークンが無効（登録解除済み）。DBから削除すべきことを示す。 */
  invalidToken?: boolean;
  error?: string;
}

/** 送信ドライバのインタフェース */
export interface FcmDriver {
  send(req: PushRequest): Promise<PushResult>;
}

/**
 * 認証情報が無い場合のドライバ。送信内容をログに出すだけ。
 * 開発時に「何が送られるはずだったか」を確認できるようにしておく。
 */
class NoopFcmDriver implements FcmDriver {
  async send(req: PushRequest): Promise<PushResult> {
    console.warn(
      `[fcm:noop] FCM未設定のため送信をスキップしました kind=${req.kind} ` +
        `token=${req.token.slice(0, 12)}... title=${req.title ?? '-'}`,
    );
    return { ok: true };
  }
}

/**
 * firebase-admin を使う実ドライバ。
 */
class FirebaseFcmDriver implements FcmDriver {
  // firebase-admin の Messaging 型。動的importのため any 相当で保持する。
  private messaging: {
    send(msg: unknown): Promise<string>;
  };

  constructor(messaging: { send(msg: unknown): Promise<string> }) {
    this.messaging = messaging;
  }

  /**
   * メッセージを1件送信する。
   *
   * kind に応じて Android の priority / channel を切り替える:
   *   - silent: data-only + high priority（Doze中でも端末を起こす）
   *   - confirming/alert/sos: high priority（全画面インテント通知のため）
   *   - watch/permission: normal priority（電池を無駄に使わない）
   */
  async send(req: PushRequest): Promise<PushResult> {
    const highPriority = ['confirming', 'alert', 'sos', 'silent'].includes(req.kind);

    // silent push は notification を含めてはならない（通知が表示されてしまう）。
    // data-only メッセージにすることでアプリが黙って起こされる。
    const isSilent = req.kind === 'silent';

    const message: Record<string, unknown> = {
      token: req.token,
      data: { kind: req.kind, ...(req.data ?? {}) },
      android: {
        priority: highPriority ? 'high' : 'normal',
        ...(isSilent ? {} : { ttl: 60 * 60 * 1000 }),
      },
    };

    if (!isSilent) {
      message.notification = { title: req.title ?? '', body: req.body ?? '' };
    }

    try {
      await this.messaging.send(message);
      return { ok: true };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // トークンが無効（アプリ削除・再インストール）。呼び出し側でDBから消す。
      const invalidToken =
        e.code === 'messaging/registration-token-not-registered' ||
        e.code === 'messaging/invalid-registration-token' ||
        e.code === 'messaging/invalid-argument';
      return { ok: false, invalidToken, error: e.message ?? String(err) };
    }
  }
}

let driver: FcmDriver | null = null;

/**
 * FCMドライバを初期化する。サーバー起動時に一度だけ呼ぶ。
 *
 * 認証情報が未設定・読み込み失敗の場合は no-op ドライバにフォールバックし、
 * 起動自体は継続する（判定エンジンは動かし続ける）。
 */
export async function initFcm(): Promise<void> {
  if (!config.FIREBASE_CREDENTIALS_PATH) {
    console.warn(
      '[fcm] FIREBASE_CREDENTIALS_PATH が未設定です。通知は送信されません（no-opドライバ）。' +
        '本番環境では必ず設定してください。',
    );
    driver = new NoopFcmDriver();
    return;
  }

  try {
    const { readFile } = await import('node:fs/promises');
    const admin = await import('firebase-admin');
    const raw = await readFile(config.FIREBASE_CREDENTIALS_PATH, 'utf8');
    const serviceAccount = JSON.parse(raw);

    const app = admin.default.apps.length
      ? admin.default.app()
      : admin.default.initializeApp({
          credential: admin.default.credential.cert(serviceAccount),
        });

    driver = new FirebaseFcmDriver(admin.default.messaging(app));
    console.log('[fcm] Firebase Admin SDK を初期化しました');
  } catch (err) {
    console.error(
      '[fcm] Firebase の初期化に失敗しました。no-opドライバで継続します:',
      err instanceof Error ? err.message : err,
    );
    driver = new NoopFcmDriver();
  }
}

/**
 * 現在のドライバを取得する（未初期化なら no-op）。
 */
export function getFcmDriver(): FcmDriver {
  if (!driver) driver = new NoopFcmDriver();
  return driver;
}

/**
 * テスト用にドライバを差し替える。
 *
 * @param d - 差し替えるドライバ
 */
export function setFcmDriver(d: FcmDriver): void {
  driver = d;
}

/**
 * リトライ付きで送信する。
 *
 * FCM送信失敗はリトライ（3回、指数バックオフ）→ 失敗を audit_log へ（spec 5.4）。
 * 無効トークンはリトライしても無駄なので即座に諦める。
 *
 * @param req - 送信リクエスト
 * @param maxAttempts - 最大試行回数
 * @returns 最終的な送信結果
 */
export async function sendWithRetry(
  req: PushRequest,
  maxAttempts = 3,
): Promise<PushResult> {
  let last: PushResult = { ok: false, error: 'not_attempted' };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await getFcmDriver().send(req);
    if (last.ok) return last;

    // 無効トークンはリトライ不要（何度送っても失敗する）
    if (last.invalidToken) return last;

    if (attempt < maxAttempts) {
      // 指数バックオフ: 200ms, 400ms
      const delay = 200 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return last;
}
