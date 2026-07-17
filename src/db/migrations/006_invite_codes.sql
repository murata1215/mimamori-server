-- =============================================================================
-- 追加ウォッチャー招待コード（多対多ペアリング）
--
-- 【背景】
-- 既にペアリング済みのクライアント端末が「追加ウォッチャー用のコード」を発行し、
-- 2人目・3人目のウォッチャーが watch_link のみを作成して紐づく。
-- 新規 client / device は作らない。
--
-- provision（初回オンボーディング用）とは責務を分離する。
-- =============================================================================

CREATE TABLE invite_codes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 招待元のクライアント
  client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- QR 用の長いランダムトークン
  invite_code    text NOT NULL UNIQUE,

  -- 手入力フォールバック用の6桁コード
  fallback_code  text NOT NULL,

  -- TTL 30分
  expires_at     timestamptz NOT NULL,

  -- join 後に設定される
  joined_at      timestamptz,
  joined_by      uuid REFERENCES watchers(id),

  created_at     timestamptz NOT NULL DEFAULT now()
);

-- join 時のコード照合
CREATE INDEX idx_invite_codes_fallback ON invite_codes (fallback_code);
-- 期限切れクリーンアップ用
CREATE INDEX idx_invite_codes_expires ON invite_codes (expires_at);
