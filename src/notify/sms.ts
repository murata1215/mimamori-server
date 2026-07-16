/**
 * SMS送信アダプタ（ownerプラン機能）。
 *
 * 【課金設計上の位置づけ】
 * SMSは1通ごとに実費が発生する。無料クライアント1人あたりの限界費用を
 * ゼロ近傍に保つ原則（spec 5）に従い、SMSは必ず有料プラン側に隔離する。
 * この関数を無料プランの経路から呼んではならない。
 *
 * 【Phase 2 で Twilio 実装を有効化】
 * 環境変数 TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER が
 * 揃っている場合のみ TwilioSmsDriver が有効になる。未設定なら
 * UnconfiguredSmsDriver が「失敗」を返す（虚偽の送信成功を残さないため）。
 *
 * 【SDKではなく REST API を直接叩く理由】
 * twilio パッケージは依存が重く（数十のtransitive依存）、このサービスが
 * 使うのは Messages API の1エンドポイントだけ。
 * 命に関わるサービスの依存ツリーは小さいほど良い（脆弱性の流入経路が減る）。
 * Node 20 の fetch で十分足りる。
 */
import { config } from '../config.js';

/** SMS送信結果 */
export interface SmsResult {
  ok: boolean;
  error?: string;
}

/** SMS送信ドライバのインタフェース */
export interface SmsDriver {
  send(to: string, body: string): Promise<SmsResult>;
}

/**
 * 未実装ドライバ。送信内容をログに出し、失敗として返す。
 *
 * 「成功」を返さないのが重要: SMSが送れていないのに送れたことにすると、
 * audit_log に虚偽の証跡が残り、免責の根拠が崩れる。
 */
class UnconfiguredSmsDriver implements SmsDriver {
  async send(to: string, body: string): Promise<SmsResult> {
    console.warn(
      `[sms:unconfigured] SMS未設定のため送信できませんでした to=${maskPhone(to)} body=${body.slice(0, 40)}...`,
    );
    return { ok: false, error: 'sms_driver_not_configured' };
  }
}

/**
 * Twilio Messages API を直接叩くドライバ（Phase 2）。
 *
 * ALERT/SOS の通知経路なので、失敗しても例外を投げず必ず SmsResult を返す。
 * ここで throw すると通知ディスパッチャのループが止まり、
 * 後続のウォッチャーへの通知が丸ごと消える（1人の送信失敗で全員が届かなくなる）。
 */
class TwilioSmsDriver implements SmsDriver {
  /** Twilio API のタイムアウト（ms）。判定ジョブを止めないため短く切る。 */
  private static readonly TIMEOUT_MS = 10_000;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
  ) {}

  async send(to: string, body: string): Promise<SmsResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`;

    // Basic認証（Twilioの標準方式）
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    // Twilio が SMS を送れないまま判定ジョブが待ち続けるのを防ぐ。
    // 毎分動くジョブが10秒以上ブロックされると見守り全体が遅延する。
    const timeout = AbortSignal.timeout(TwilioSmsDriver.TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: this.fromNumber, Body: body }),
        signal: timeout,
      });

      if (res.ok) return { ok: true };

      // エラー本文には送信先番号が含まれうるため、そのままログ・監査へ流さない。
      // Twilio のエラーコードだけを取り出す。
      let code: string | number = res.status;
      try {
        const json = (await res.json()) as { code?: number };
        if (json.code) code = json.code;
      } catch {
        // JSON でない場合はHTTPステータスのみで十分
      }
      console.error(`[sms:twilio] 送信失敗 to=${maskPhone(to)} code=${code}`);
      return { ok: false, error: `twilio_error_${code}` };
    } catch (err) {
      // タイムアウト・ネットワーク断
      const reason = err instanceof Error ? err.name : 'unknown';
      console.error(`[sms:twilio] 送信例外 to=${maskPhone(to)} reason=${reason}`);
      return { ok: false, error: `twilio_${reason}` };
    }
  }
}

/**
 * 設定に応じてドライバを選ぶ。
 *
 * config 側で「3つ揃っているか全て未設定か」を検証済みなので、
 * ここでは1つの存在確認で足りる。
 *
 * @returns 有効なドライバ
 */
function selectDriver(): SmsDriver {
  if (config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_FROM_NUMBER) {
    console.info('[sms] Twilio ドライバを使用します');
    return new TwilioSmsDriver(
      config.TWILIO_ACCOUNT_SID,
      config.TWILIO_AUTH_TOKEN,
      config.TWILIO_FROM_NUMBER,
    );
  }
  console.warn('[sms] Twilio 未設定のため SMS は送信されません（ownerプランのSMSは無効）');
  return new UnconfiguredSmsDriver();
}

let driver: SmsDriver = selectDriver();

/**
 * SMSドライバを差し替える（Phase 2 の Twilio 実装・テスト用）。
 *
 * @param d - 差し替えるドライバ
 */
export function setSmsDriver(d: SmsDriver): void {
  driver = d;
}

/**
 * 電話番号をログ用にマスクする。
 * 監査ログ・アプリログに生の電話番号を残さない。
 *
 * @param phone - 電話番号
 * @returns 末尾4桁のみ残した文字列
 */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return '*'.repeat(phone.length - 4) + phone.slice(-4);
}

/**
 * SMSを送信する。
 *
 * @param to - 送信先電話番号（E.164形式）
 * @param body - 本文
 * @returns 送信結果
 */
export async function sendSms(to: string, body: string): Promise<SmsResult> {
  return driver.send(to, body);
}
