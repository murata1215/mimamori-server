-- =============================================================================
-- クライアント（見守られ側）の機種変更対応
--
-- 【背景】
-- クライアントはデバイストークンのみでアカウント概念がなく、機種変更すると
-- 再ペアリング（全ウォッチャーの再登録）が必要だった。
-- メール+パスワードを付与すれば、新端末でログイン → 同じ client_id を継続
-- （watch_links・スタンプ履歴・ステータス履歴そのまま）できるようにする。
--
-- 【旧端末の無効化】
-- login 時に旧デバイスを deactivated_at で論理無効化する。
-- 物理削除ではなく論理削除にするのは audit_log との突き合わせで
-- 「いつ・どのデバイスが有効だったか」を追跡するため。
-- requireDevice ガードで deactivated_at IS NULL をチェックし、
-- 旧端末のJWTを即座に無効化する。
--
-- 旧端末を無効化しないと:
--   - confirm_alive が旧端末から応答され ALIVE 誤復帰（絶対ルール1違反）
--   - screen_on_count>0 のハートビートが生存イベント扱いされ検知漏れ
--   - last_heartbeat_at が更新され端末沈黙検出が機能しない
-- =============================================================================

-- clients にメール認証カラムを追加（watchers と同じパターン）
-- NULL 可: メール未登録のクライアントが大多数（高齢者は登録しないことが多い）
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email text UNIQUE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS password_hash text;

-- 旧端末無効化用のタイムスタンプ
-- NULL = 有効、非NULL = 無効化済み
ALTER TABLE devices ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;

-- requireDevice で毎リクエスト参照するため、有効デバイスだけの部分インデックス
CREATE INDEX IF NOT EXISTS idx_devices_active ON devices (id) WHERE deactivated_at IS NULL;
