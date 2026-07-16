-- =============================================================================
-- mimamori-server 初期スキーマ (Phase 1 MVP)
--
-- 設計の根幹（mimamori-spec.md の原則に対応）:
--   - 原則1「プライバシー最小開示」: 位置情報は sos_incidents にのみ存在し、
--     events テーブルには絶対に入れない。events.meta に行動詳細（アプリ名・URL）を
--     入れることも禁止（コードレビュー基準）。
--   - 原則2「サーバー側判定」: 端末はイベントを送るだけ。判定に必要な状態は
--     すべてこのDBに集約する。
--   - 原則4「スマホは数あるセンサーの一つ」: events は全ソース共通の正規化形式。
--     ソース追加時に events のスキーマを変更してはならない（変更が必要になった
--     時点でアダプタ設計の失敗）。
-- =============================================================================

-- gen_random_uuid() のため（PostgreSQL 13+ では組み込みだが明示的に有効化）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- clients: 見守られる人
--
-- 判定ジョブは毎分このテーブルを全件スキャンするため、判定に必要な値
-- (last_alive_event_at 等) を events から非正規化して保持する。
-- events への MAX(occurred_at) 集約を毎分実行するのは非現実的なため。
-- これらの非正規化カラムはイベント投入時に同一トランザクションで更新する。
-- -----------------------------------------------------------------------------
CREATE TABLE clients (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name           text NOT NULL,

  -- 4段階ステータス + CONFIRMING（本人確認中）。ウォッチャーに開示されるのはこれだけ。
  status                 text NOT NULL DEFAULT 'ALIVE'
                           CHECK (status IN ('ALIVE','WATCH','CONFIRMING','ALERT','SOS')),
  status_changed_at      timestamptz NOT NULL DEFAULT now(),

  -- 現在有効な閾値（分）。学習結果 or デフォルト。既定は15時間 = 900分。
  threshold_minutes      int NOT NULL DEFAULT 900,
  threshold_mode         text NOT NULL DEFAULT 'default'
                           CHECK (threshold_mode IN ('default','learned')),

  -- 同意記録（法務要件: 契約不要にはできても同意不要にはできない）
  consent_version        text,
  consent_at             timestamptz,

  -- Phase 2: センサーのみクライアント（アプリなし物件）。
  -- false の場合 CONFIRMING をスキップし WATCH→ALERT に猶予時間を挟む別プロファイル。
  has_app                boolean NOT NULL DEFAULT true,

  -- オーナープラン: 物件グルーピング用タグ
  property_tag           text,

  -- --- 判定ジョブ用の非正規化カラム（events から導出） ---

  -- 最後の「本人が生きている」イベント時刻。経過時間計算の基準点。
  -- heartbeat のうち screen_on_count>0 または had_app_usage=true のもの、
  -- activity, confirm_alive がこれを更新する。
  last_alive_event_at    timestamptz NOT NULL DEFAULT now(),

  -- 最後に heartbeat を受信した時刻（操作の有無を問わない）。
  -- 「端末が生きている」と「本人が生きている」を区別するために last_alive_event_at と分離。
  -- 端末沈黙(source_silent)の検出に使う。
  last_heartbeat_at      timestamptz,

  -- CONFIRMING に入った時刻。30分無応答タイムアウトの基準。
  confirming_since       timestamptz,

  -- 最後に ALERT をウォッチャーへ通知した時刻。ALERT の24h周期再通知に使う。
  last_alert_notified_at timestamptz,

  -- 閾値50%到達時の silent push を送った時刻。同一沈黙期間中の多重送信防止。
  -- 生存イベント受信でクリアされる。
  silent_push_sent_at    timestamptz,

  created_at             timestamptz NOT NULL DEFAULT now()
);

-- 判定ジョブは status で絞って全件走査する
CREATE INDEX idx_clients_status ON clients (status);
CREATE INDEX idx_clients_property_tag ON clients (property_tag) WHERE property_tag IS NOT NULL;

-- -----------------------------------------------------------------------------
-- watchers: 見守る人
-- -----------------------------------------------------------------------------
CREATE TABLE watchers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  email         text NOT NULL UNIQUE,

  -- scrypt によるハッシュ（形式: scrypt$N$r$p$salt_b64$hash_b64）。平文は保存しない。
  password_hash text NOT NULL,

  plan          text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','owner')),
  fcm_token     text,

  -- SMSフォールバック用（ownerプランのみ利用。限界費用が発生するため無料枠では使わない）
  phone_number  text,

  -- 注視(WATCH)通知の受信可否。デフォルトON（flutter spec 4.2）。
  notify_watch  boolean NOT NULL DEFAULT true,

  created_at    timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- watch_links: 紐づけ（課金単位の実体）
--
-- billable は「そのwatcherにとって3人目以降か」を作成時に確定させる。
-- 後から2人目が解除されても既存linkのbillableは動かさない（課金の予測可能性のため）。
-- -----------------------------------------------------------------------------
CREATE TABLE watch_links (
  watcher_id uuid NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','secondary')),
  billable   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watcher_id, client_id)
);

CREATE INDEX idx_watch_links_client ON watch_links (client_id);

-- -----------------------------------------------------------------------------
-- events: 生存イベント（イベント抽象化の核。全ソース共通）
--
-- occurred_at による月次レンジパーティション。
-- パーティションキーを含める制約があるため PK は (id, occurred_at)。
--
-- 【禁止事項】meta に行動詳細（アプリ名・URL・位置情報）を入れてはならない。
-- 入れてよいのは battery_level, screen_on_count, had_app_usage 等の
-- 「本人が生きているか」の判定にのみ使う値に限る。
-- -----------------------------------------------------------------------------
CREATE TABLE events (
  id          bigserial,
  client_id   uuid NOT NULL,
  source_type text NOT NULL,   -- 'phone' | 'switchbot_contact' | 'switchbot_plug' | 'power_meter' | ...
  source_id   text,            -- デバイス識別子
  event_type  text NOT NULL
                CHECK (event_type IN ('heartbeat','activity','sos','confirm_alive','source_silent')),
  occurred_at timestamptz NOT NULL,  -- 発生時刻（端末キュー再送でも元時刻を保持）
  received_at timestamptz NOT NULL DEFAULT now(),
  confidence  smallint NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- 判定・学習の主アクセスパターン
CREATE INDEX idx_events_client_occurred ON events (client_id, occurred_at DESC);

-- キュー再送による重複投入を防ぐ。
-- 端末はオフライン時にローカルキューへ蓄積し後でまとめて送るため、
-- 同一イベントが複数回届きうる。ON CONFLICT DO NOTHING で冪等にする。
CREATE UNIQUE INDEX idx_events_dedupe
  ON events (client_id, source_type, event_type, occurred_at);

-- -----------------------------------------------------------------------------
-- sos_incidents: SOS（位置情報の隔離先）
--
-- 位置情報がこのテーブルにしか存在しないことがプライバシー設計の要。
-- purge_after (fired_at + 30日) を過ぎたら日次バッチで物理削除する。
-- -----------------------------------------------------------------------------
CREATE TABLE sos_incidents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  latitude      double precision,   -- 取得失敗時は NULL（「位置不明」でも送信を優先する仕様）
  longitude     double precision,
  battery_level int,
  fired_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES watchers(id) ON DELETE SET NULL,

  -- fired_at + 30日。この時刻を過ぎた行はバッチで物理削除。
  purge_after   timestamptz NOT NULL
);

CREATE INDEX idx_sos_client_fired ON sos_incidents (client_id, fired_at DESC);
CREATE INDEX idx_sos_purge ON sos_incidents (purge_after);

-- -----------------------------------------------------------------------------
-- thresholds: 閾値学習結果
--
-- 曜日(0-6) × 時間帯バケット(4h刻み: 0-5) ごとに、生存イベント間隔の p99 を保持。
-- 有効閾値 = p99 + マージン。sample_count 不足時はデフォルトへフォールバック。
-- -----------------------------------------------------------------------------
CREATE TABLE thresholds (
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  dow             smallint NOT NULL CHECK (dow BETWEEN 0 AND 6),
  hour_bucket     smallint NOT NULL CHECK (hour_bucket BETWEEN 0 AND 5),
  p99_gap_minutes int NOT NULL,
  sample_count    int NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, dow, hour_bucket)
);

-- -----------------------------------------------------------------------------
-- audit_log: 状態遷移・通知の監査ログ
--
-- 免責の証跡。紛争時に「いつ検知し、いつ通知したか」を示す唯一の根拠。
-- 【重要】このテーブルの行は削除しない（purge対象外）。
-- ただし detail に位置情報を入れてはならない（位置は sos_incidents のみ）。
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  client_id  uuid,
  event      text NOT NULL,   -- 'status_change' | 'notification_sent' | 'notification_failed' | ...
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_client_created ON audit_log (client_id, created_at DESC);
CREATE INDEX idx_audit_event_created ON audit_log (event, created_at DESC);

-- -----------------------------------------------------------------------------
-- devices: クライアント端末
-- last_seen_at はハートビート生存率KPI（24h以内到達端末率）の算出元。
-- -----------------------------------------------------------------------------
CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform     text NOT NULL,
  fcm_token    text,
  app_version  text,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_client ON devices (client_id);

-- -----------------------------------------------------------------------------
-- pairing_codes: ペアリングコード（TTL 15分）
-- 6桁コード。使い捨て（used=true で再利用不可）。
-- -----------------------------------------------------------------------------
CREATE TABLE pairing_codes (
  code       text PRIMARY KEY,
  watcher_id uuid NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pairing_expires ON pairing_codes (expires_at);

-- -----------------------------------------------------------------------------
-- job_runs: 判定ジョブの最終実行時刻
--
-- サービス自身のデッドマンスイッチ。/healthz がこれを読み、
-- 判定ジョブが10分以上止まっていたら503を返す。
-- 「見守りサービス自身が沈黙することは許されない」(spec 7.3) の実装。
-- -----------------------------------------------------------------------------
CREATE TABLE job_runs (
  job_name   text PRIMARY KEY,
  last_run_at timestamptz NOT NULL,
  last_status text NOT NULL DEFAULT 'ok',
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- -----------------------------------------------------------------------------
-- service_outages: サービス停止の記録
--
-- 停止が閾値超過時間に及んだ場合、復旧時に全ウォッチャーへ正直に通知するため
-- （「黙って再開しない」= 信頼の担保）。notified_at が NULL の停止は未通知。
-- -----------------------------------------------------------------------------
CREATE TABLE service_outages (
  id              bigserial PRIMARY KEY,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  gap_minutes     int NOT NULL,
  notified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
