-- =============================================================================
-- 逆方向ペアリング（provision → claim）
--
-- 【背景】
-- 見守られる側は高齢者。操作を極限まで減らすため、ペアリングの方向を逆転する。
-- 旧: ウォッチャーがコード発行 → 高齢者端末で入力（操作が多い）
-- 新: 高齢者はアプリ起動+同意タップ → QR表示 → ウォッチャーがスキャン
--
-- provision は clients / devices / watch_links を一切触れない。
-- claim されなければ期限切れで自動削除される（orphan なし）。
-- =============================================================================

CREATE TABLE provisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- QR 用の長いランダムトークン（UUID 形式。推測困難）
  claim_code      text NOT NULL UNIQUE,

  -- 手入力フォールバック用の6桁コード
  fallback_code   text NOT NULL,

  -- ポーリング認証用の秘密値（claim_code とは別値。QR が漏れてもポーリング不可）
  claim_secret    text NOT NULL UNIQUE,

  -- 端末情報（claim 時に device レコードへ移行する）
  platform        text NOT NULL,
  app_version     text,
  fcm_token       text,

  -- 同意記録（法務要件 spec 7.1: 本人端末から受け取る）
  consent_version text NOT NULL,

  -- TTL（30分）
  expires_at      timestamptz NOT NULL,

  -- claim 後に設定される
  claimed_at      timestamptz,
  claimed_by      uuid REFERENCES watchers(id),
  client_id       uuid REFERENCES clients(id),
  device_id       uuid REFERENCES devices(id),

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- claim 時のコード照合（claim_code または fallback_code の両方で引ける）
CREATE INDEX idx_provisions_fallback ON provisions (fallback_code);
-- 期限切れクリーンアップ用
CREATE INDEX idx_provisions_expires ON provisions (expires_at);
