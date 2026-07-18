-- =============================================================================
-- 移動有無シグナル + SOS キャッシュ位置のタイムスタンプ
--
-- 【had_movement】
-- heartbeat に optional boolean `had_movement` を追加。
-- events.meta (jsonb) に格納されるためテーブルスキーマの変更は不要。
-- 座標・距離・軌跡は受け取らない（プライバシー原則不変）。
-- had_movement = true は screen_on_count / had_app_usage と並ぶ
-- 「本人が生きている」シグナルとして生存イベント判定に使われる。
--
-- 【location_captured_at】
-- SOS 発動時、端末が新規測位に失敗しキャッシュ位置を送る場合がある。
-- 「この位置は何分前のものか」をウォッチャーに伝えるため、
-- sos_incidents に測位時刻を記録する。省略時は fired_at と同義。
-- =============================================================================

ALTER TABLE sos_incidents
  ADD COLUMN IF NOT EXISTS location_captured_at timestamptz;
