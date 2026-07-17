-- =============================================================================
-- 匿名ウォッチャー登録（ログイン不要化）
--
-- 【背景】
-- ウォッチャーの登録障壁を下げるため、メール+パスワードなしでの端末登録を可能にする。
-- install_id（アプリ生成UUID）で端末を識別し、同一 install_id で再呼び出しすれば
-- 既存 watcher のトークンを再発行する（冪等）。
-- あとからメール登録（任意）で機種変更時の復元等に対応。
-- =============================================================================

-- email を NULL 可に（匿名ウォッチャーはメール未登録）
ALTER TABLE watchers ALTER COLUMN email DROP NOT NULL;

-- password_hash を NULL 可に（匿名ウォッチャーはパスワード未設定）
ALTER TABLE watchers ALTER COLUMN password_hash DROP NOT NULL;

-- 端末識別用の install_id（アプリ生成UUID。端末に永続保存）
-- NULL 可: メール登録済みユーザーは install_id を持たない場合がある
ALTER TABLE watchers ADD COLUMN install_id text UNIQUE;
