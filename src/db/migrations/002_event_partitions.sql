-- =============================================================================
-- events テーブルの月次パーティション管理
--
-- events は occurred_at による RANGE パーティション。
-- 該当パーティションが存在しない時刻のイベントを INSERT すると
-- "no partition of relation found for row" エラーになり、
-- ハートビートが失われる = 見守りが機能しなくなる。
--
-- したがってパーティションの先行作成は「あれば良い運用」ではなく必須要件。
-- 起動時と日次ジョブの両方で ensure_event_partitions() を呼ぶ。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 指定月のパーティションを1つ作成する（既に存在すれば何もしない）
--
-- @param target_month  対象月の任意の日付（内部で月初に丸める）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_event_partition(target_month date)
RETURNS void AS $$
DECLARE
  start_date date;
  end_date   date;
  part_name  text;
BEGIN
  start_date := date_trunc('month', target_month)::date;
  end_date   := (start_date + interval '1 month')::date;
  part_name  := 'events_' || to_char(start_date, 'YYYY_MM');

  -- to_regclass は存在しないリレーションに対して NULL を返す（例外を投げない）
  IF to_regclass('public.' || part_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      part_name, start_date, end_date
    );
    RAISE NOTICE 'created partition %', part_name;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 過去1ヶ月〜未来3ヶ月分のパーティションを確保する
--
-- 過去分も作るのは、端末のローカルキューが長期オフライン後に
-- 古い occurred_at のイベントをまとめて再送してくるため
-- （flutter spec 3.2: 送信失敗時はキューに蓄積し occurred_at は元の時刻を保持）。
-- 未来分を多めに作るのは、日次ジョブが数日止まってもINSERTが失敗しないようにするため。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_event_partitions()
RETURNS void AS $$
DECLARE
  m int;
BEGIN
  FOR m IN -1..3 LOOP
    PERFORM create_event_partition((date_trunc('month', now()) + (m || ' month')::interval)::date);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 想定外の occurred_at を持つイベントの受け皿。
--
-- パーティション範囲外のINSERTでハートビートを取りこぼすことは
-- 「見守りの穴」に直結するため、DEFAULT パーティションで必ず受け止める。
-- ここに行が溜まっている＝パーティション運用に問題があるサイン（監視対象）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events_default PARTITION OF events DEFAULT;

-- 初期パーティションを作成
SELECT ensure_event_partitions();
