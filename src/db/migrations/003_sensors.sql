-- =============================================================================
-- Phase 2: センサーソースの追加（アダプタ規約の実証）
--
-- 【このマイグレーションの設計方針】
-- spec 8 のアダプタ規約は「新ソースは events への正規化挿入のみを実装する。
-- 判定エンジン・状態遷移・学習・通知は無改修であること」と定めている。
-- したがってここで追加するのは
--   1. デバイス → クライアントの逆引き表（client_sensors）
--   2. 低信頼ソースの弱シグナル時刻（clients.last_weak_signal_at）
-- のみであり、events のスキーマには一切手を触れていない。
-- events を変更せずに新ソースを追加できたこと自体が、Phase 1 の抽象化が
-- 正しかったことの検証になっている。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- client_sensors: 物理デバイス → クライアントの紐づけ
--
-- Webhook は「どのデバイスからのイベントか」しか分からない（SwitchBot なら
-- deviceMac）。誰の見守りに属するかを解決する逆引きがないと events へ入れられない。
-- Phase 1 で SwitchBot webhook が 501 を返していたのは、この表が無かったため。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_sensors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- events.source_type と同じ語彙を使う。
  -- 【重要】ここに登録された source_type を events へ書く。
  -- Webhook ペイロードの形から推測してはならない（後述の resolve 実装を参照）。
  source_type  text NOT NULL
                 CHECK (source_type IN ('switchbot_contact','switchbot_plug','power_meter')),

  -- デバイス識別子（SwitchBot: deviceMac / 電力メーター: 供給地点特定番号 等）。
  --
  -- 【UNIQUE を source_id 単独に張る理由】
  -- 1台の物理デバイスが2人のクライアントに紐づくと、Webhook 受信時に
  --    どちらの見守りへイベントを入れるべきか決定できない。
  --    「両方に入れる」は他人の生活シグナルを別人の判定に混ぜることであり、
  --    見守りとしても個人情報保護としても破綻する。
  -- 2. (source_type, source_id) の複合にすると、同じ MAC を種別違いで
  --    二重登録できてしまい、上記の曖昧さが復活する。
  source_id    text NOT NULL UNIQUE,

  -- このセンサーからのイベントの信頼度（events.confidence へ書く値）。
  -- 登録時にソース種別から決定し、以後この値を使う。
  -- 100 = 本人の行動とみなせる / 100未満 = 弱シグナル（後述）。
  confidence   smallint NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),

  -- ウォッチャーが設置場所を判別するための表示名（例: 「玄関ドア」「電気ポット」）。
  -- 【注意】これは設定情報であって行動情報ではない。開示してよい。
  display_name text,

  -- 一時的に無効化する場合（電池交換中・引っ越し中など）。
  -- 無効化されたセンサーのイベントは受け付けない（events へ入れない）。
  enabled      boolean NOT NULL DEFAULT true,

  -- 運用・障害調査用。【重要】ウォッチャー向けAPIで返してはならない。
  -- 「玄関が最後に開いた時刻」= 行動詳細そのものであり、原則1に真っ向から反する。
  last_event_at timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Webhook 受信のたびに source_id で逆引きするため（UNIQUE 制約が索引を兼ねる）。
-- クライアント単位の一覧取得用に別途張る。
CREATE INDEX IF NOT EXISTS idx_client_sensors_client ON client_sensors (client_id);

-- -----------------------------------------------------------------------------
-- clients.last_weak_signal_at: 低信頼ソースからの最終シグナル時刻
--
-- 【なぜ last_alive_event_at と分けるのか — Phase 2 で最も重要な判断】
-- spec 8 は電力メーターを「confidence 70程度の低信頼ソースとして扱う」と定める。
-- 一方 spec 5.1 の生存イベント定義は event_type だけを見ており、confidence を見ない。
-- この2つを額面どおり実装すると、電力の変動が last_alive_event_at を更新し、
-- 経過時間が毎回リセットされる。
--
-- その結果どうなるか: 冷蔵庫のコンプレッサーは住人が死んでも回り続ける。
-- つまり「本人が倒れていても電力メーターが永遠に生存を証明し続ける」状態になり、
-- デッドマンスイッチが二度と発報しない。誤報より遥かに悪い。
-- 「見守っているつもりで誰も見ていない」= このサービスが唯一犯してはならない失敗。
--
-- よって低信頼ソースは last_alive_event_at を更新しない。
-- 別カラムに退避し、クロス判定（spec 5.2）の材料としてのみ使う。
-- -----------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_weak_signal_at timestamptz;

COMMENT ON COLUMN clients.last_weak_signal_at IS
  '低信頼ソース(confidence < 80)の最終シグナル時刻。生存判定の基準点にはしない。'
  'クロス判定（端末沈黙中に他ソースが生きている場合のALERT抑制）にのみ使う。';
