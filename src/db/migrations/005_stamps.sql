-- =============================================================================
-- スタンプ機能（双方向の軽量コミュニケーション）
--
-- クライアント（見守られる側）とウォッチャー（見守る側）で
-- スタンプを双方向にやり取りする。テキストメッセージはなし。
-- stamp カラムは text（enum にしない）で、種類の追加にスキーマ変更不要。
-- 90日経過分は日次クリーンアップで物理削除。
-- =============================================================================

CREATE TABLE stamps (
  id          bigserial PRIMARY KEY,
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  direction   text NOT NULL CHECK (direction IN ('from_client', 'from_watcher')),
  sender_id   uuid NOT NULL,          -- client_id (from_client) or watcher_id (from_watcher)
  sender_name text NOT NULL,          -- 送信時点の display_name をスナップショット保存
  stamp       text NOT NULL,          -- 'fine', 'not_well', 'bad', ...
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 履歴取得は client_id + created_at DESC で走査する
CREATE INDEX idx_stamps_client_created ON stamps (client_id, created_at DESC);
