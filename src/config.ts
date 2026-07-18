/**
 * 環境変数の読み込みと検証。
 *
 * 起動時に一度だけ検証し、不正なら即座に落とす（fail fast）。
 * 見守りサービスが「設定ミスで静かに誤動作している」状態が最も危険なため、
 * 曖昧なフォールバックは持たせない。
 */
import 'dotenv/config';
import { z } from 'zod';

/**
 * 環境変数のスキーマ。
 * 判定パラメータを環境変数化しているのは、Phase 1 で誤報率を見ながら
 * 再デプロイなしに調整する必要があるため（KPI: 誤報率5%未満）。
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(9021),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL は必須です'),

  /** JWT署名鍵。本番では必ず十分な長さのランダム値を設定すること。 */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET は32文字以上必要です'),

  /** ウォッチャー用アクセストークンの有効期限 */
  JWT_ACCESS_TTL: z.string().default('1h'),
  /** ウォッチャー用リフレッシュトークンの有効期限 */
  JWT_REFRESH_TTL: z.string().default('30d'),
  /**
   * クライアント端末トークンの有効期限。
   * 端末は「一度設定したら二度と触らない」のが理想（flutter spec 1）なので、
   * 再ログインを強いない長期トークンとする。
   */
  JWT_DEVICE_TTL: z.string().default('3650d'),

  // --- 判定エンジンのパラメータ ---

  /** コールドスタート時のデフォルト閾値（分）。15時間。 */
  DEFAULT_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(900),
  /**
   * iOS 端末向けのデフォルト閾値（分）。24時間。
   * iOS はバックグラウンド実行が OS 任せで 15分周期ハートビートが保証されない。
   * screen_on_count / had_app_usage 相当の API もないため、生存シグナルは
   * had_movement・アプリ起動時送信・BGAppRefresh に依存し、間隔が長くなる。
   * 学習が進めば iOS の実シグナル間隔 p99 に自然収束する。
   */
  DEFAULT_THRESHOLD_MINUTES_IOS: z.coerce.number().int().positive().default(1440),
  /** オンボーディングで「よく触る」を選んだ場合の初期閾値（分）。10時間。 */
  FREQUENT_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(600),
  /** 学習閾値の下限（分）。6時間。学習の暴走防止。 */
  MIN_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(360),
  /** 学習閾値の上限（分）。24時間。 */
  MAX_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(1440),
  /** 学習時に p99 に加算するマージン（分）。2時間。 */
  THRESHOLD_MARGIN_MINUTES: z.coerce.number().int().nonnegative().default(120),
  /** 学習に必要な最低サンプル数。これ未満のバケットはデフォルトへフォールバック。 */
  MIN_SAMPLE_COUNT: z.coerce.number().int().positive().default(20),
  /** 学習の対象期間（週）。直近8週間。 */
  LEARNING_WINDOW_WEEKS: z.coerce.number().int().positive().default(8),
  /** 登録から学習を開始するまでの日数（コールドスタート期間）。 */
  COLD_START_DAYS: z.coerce.number().int().positive().default(14),

  /** CONFIRMING（本人確認）の無応答タイムアウト（分）。超過で ALERT。 */
  CONFIRMING_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  /** ALERT の再通知間隔（時間）。同一 ALERT を24hごとに再通知。 */
  ALERT_RENOTIFY_HOURS: z.coerce.number().int().positive().default(24),
  /**
   * has_app=false（センサーのみ）クライアント用の猶予時間（分）。
   * CONFIRMING をスキップするため、WATCH→ALERT の間にこの猶予を挟む。
   */
  NO_APP_GRACE_MINUTES: z.coerce.number().int().positive().default(60),

  /**
   * 弱シグナル（低信頼ソース）を「まだ新しい」とみなす時間（分）。Phase 2 クロス判定。
   * 既定90分は電力Bルートの30分周期の3倍。端末沈黙の判定を
   * ハートビート周期(15分)の3倍=45分としているのと同じ考え方
   * （2回連続の欠測は通信の揺らぎでも起きるが、3回続くならソースが死んでいる）。
   */
  WEAK_SIGNAL_FRESH_MINUTES: z.coerce.number().int().positive().default(90),

  /**
   * クロス判定が ALERT を保留できる最大時間（分）。Phase 2。
   *
   * 【この上限を外してはならない】
   * 弱シグナル（家全体の電力変動）は本人が倒れていても発生し続けるため、
   * 上限が無いとデッドマンスイッチが永久に発報しなくなる。
   * 既定3時間は「電池切れに気づいて充電する」のに現実的な時間として置いた暫定値。
   * 実データの誤報率・検知遅延を見て調整すること（doc/issues.md）。
   */
  CROSS_CHECK_HOLD_MINUTES: z.coerce.number().int().positive().default(180),

  /** 判定ジョブがこの分数以上停止していたら /healthz が 503 を返す。 */
  HEALTH_JOB_STALL_MINUTES: z.coerce.number().int().positive().default(10),

  /** SOS の位置情報を物理削除するまでの日数。 */
  SOS_PURGE_DAYS: z.coerce.number().int().positive().default(30),

  // --- 外部サービス（未設定でも起動する。その場合は該当機能が無効化される） ---

  /** Firebase サービスアカウントJSONのパス。未設定ならFCMはno-opドライバになる。 */
  FIREBASE_CREDENTIALS_PATH: z.string().optional(),

  /** RevenueCat Webhook の認証ヘッダ値。未設定なら webhook は 503 を返す。 */
  REVENUECAT_WEBHOOK_SECRET: z.string().optional(),

  /** SwitchBot Webhook 署名検証鍵（Phase 2）。 */
  SWITCHBOT_WEBHOOK_SECRET: z.string().optional(),

  /**
   * 電力メーター（Bルート/電力会社API）連携の Webhook 認証鍵（Phase 2）。
   * 未設定なら該当 webhook は 503。
   */
  POWER_METER_WEBHOOK_SECRET: z.string().optional(),

  // --- Twilio（ownerプランのSMSフォールバック。Phase 2） ---
  //
  // 3つ揃って初めて有効化される。中途半端に設定された状態で
  // 「送れたつもり」になるのを防ぐため、起動時に組で検証する（下部の refine 参照）。
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  /** 送信元電話番号（E.164形式。例: +815012345678） */
  TWILIO_FROM_NUMBER: z.string().optional(),
})
  /**
   * Twilio の設定は「3つ全部」か「3つとも無し」のどちらかでなければならない。
   *
   * 1つでも欠けた状態を許すと、ownerプランのALERTでSMS送信を試みて毎回失敗する。
   * 「設定ミスで静かに誤動作している」状態こそ見守りサービスで最も危険なので、
   * 起動時に落とす（fail fast）。
   */
  .superRefine((v, ctx) => {
    const keys = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'] as const;
    const present = keys.filter((k) => v[k] !== undefined && v[k] !== '');
    if (present.length > 0 && present.length < keys.length) {
      const missing = keys.filter((k) => !present.includes(k));
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TWILIO_ACCOUNT_SID'],
        message: `Twilio設定が不完全です。未設定: ${missing.join(', ')}。全て設定するか全て未設定にしてください`,
      });
    }
  });

/**
 * 検証済みの環境変数。
 * 検証に失敗した場合はエラー内容を出力してプロセスを終了する。
 */
function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[config] 環境変数の検証に失敗しました:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();

export type Config = typeof config;
