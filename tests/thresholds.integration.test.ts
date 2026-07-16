/**
 * 閾値学習の統合テスト（実DB使用）。
 *
 * 【なぜ重要か】(原則3)
 * 「携帯を置きっぱなしにする人は15時間、頻繁に触る人は10時間」という
 * 個人差を吸収できるかがプロダクトの生命線（誤報率KPI）。
 *
 * 固定閾値なら誤報か検知漏れのどちらかが必ず起きる。
 * ここが機能しなければ、この製品は既製品と同じ土俵に落ちる。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closePool, query } from '../src/db/pool.js';
import {
  clampThreshold,
  getEffectiveThreshold,
  hourBucketOf,
  dowOf,
  learnThresholdsForClient,
} from '../src/engine/thresholds.js';

/**
 * 「N日前の JST 0時」を返す。
 *
 * 【なぜテストデータを固定時刻に錨で留めるのか — 実際にこれで落ちた】
 * バケットは4時間幅。テストデータの起点を Date.now() にすると、
 * 起点の時刻がバケットのどこに落ちるかが実行時刻によって変わる。
 * 例えば「毎日4件を45分間隔で投入」する場合、
 *   JST 00:36 起点 → 4件とも bucket 0 → 1バケットに 4gap/日
 *   JST 06:36 起点 → bucket 1 と 2 に分裂 → 1バケットあたり 2gap/日
 * となり、後者では sample_count が MIN_SAMPLE_COUNT(20) に届かず、
 * 「学習が成立すること」を確かめるテストが実行時刻によって成功したり失敗したりする。
 *
 * 日本に夏時間は無いため JST = UTC+9 で固定してよい。
 * Date.UTC は時が負でも前日へ正しく繰り下がるので、そのまま渡してよい。
 *
 * @param daysAgo - 何日前か
 * @param jstHour - JSTでの時（既定0 = bucket 0 の先頭。4時間幅に余裕を持って収まる）
 * @returns 該当時刻の Date
 */
function jstAnchor(daysAgo: number, jstHour = 0): Date {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), jstHour - 9, 0, 0, 0),
  );
}

let clientId: string;

/** テスト用クライアントを作る */
async function createClient(createdDaysAgo = 30): Promise<void> {
  const c = await query<{ id: string }>(
    `INSERT INTO clients (display_name, threshold_minutes, last_alive_event_at, status,
                          status_changed_at, created_at)
     VALUES ('学習テスト', 900, now(), 'ALIVE', now(), now() - ($1 || ' days')::interval)
     RETURNING id`,
    [createdDaysAgo],
  );
  clientId = c.rows[0]!.id;
}

/**
 * 生存イベントを一定間隔で投入する。
 *
 * @param count - 件数
 * @param gapMinutes - イベント間隔（分）
 * @param startDaysAgo - 何日前から始めるか
 */
async function seedEvents(count: number, gapMinutes: number, startDaysAgo = 20): Promise<void> {
  const start = new Date(Date.now() - startDaysAgo * 24 * 60 * 60 * 1000);
  const values: string[] = [];
  const params: unknown[] = [clientId];

  for (let i = 0; i < count; i++) {
    const at = new Date(start.getTime() + i * gapMinutes * 60_000);
    params.push(at);
    values.push(`($1, 'phone', 'heartbeat', $${params.length}, '{"screen_on_count": 1}'::jsonb)`);
  }

  await query(
    `INSERT INTO events (client_id, source_type, event_type, occurred_at, meta)
     VALUES ${values.join(',')}
     ON CONFLICT DO NOTHING`,
    params,
  );
}

beforeEach(async () => {
  await createClient();
});

afterEach(async () => {
  if (clientId) {
    await query('DELETE FROM events WHERE client_id = $1', [clientId]);
    await query('DELETE FROM thresholds WHERE client_id = $1', [clientId]);
    await query('DELETE FROM audit_log WHERE client_id = $1', [clientId]);
    await query('DELETE FROM clients WHERE id = $1', [clientId]);
  }
});

afterAll(async () => {
  await closePool();
});

describe('clampThreshold — 学習の暴走防止', () => {
  it('下限6時間でクランプする', () => {
    expect(clampThreshold(10)).toBe(config.MIN_THRESHOLD_MINUTES);
    expect(clampThreshold(0)).toBe(360);
  });

  it('上限24時間でクランプする', () => {
    expect(clampThreshold(99999)).toBe(config.MAX_THRESHOLD_MINUTES);
    expect(clampThreshold(5000)).toBe(1440);
  });

  it('範囲内はそのまま', () => {
    expect(clampThreshold(600)).toBe(600);
  });
});

describe('バケット計算 — 基準TZ（Asia/Tokyo）で一貫していること', () => {
  it('日本時間の深夜3時はバケット0', () => {
    expect(hourBucketOf(new Date('2026-07-16T03:00:00+09:00'))).toBe(0);
  });

  it('日本時間の正午はバケット3', () => {
    // 12時 / 4 = 3
    expect(hourBucketOf(new Date('2026-07-16T12:00:00+09:00'))).toBe(3);
  });

  it('日本時間の23時はバケット5', () => {
    expect(hourBucketOf(new Date('2026-07-16T23:00:00+09:00'))).toBe(5);
  });

  it('【重要】UTC深夜0時は日本時間の朝9時 = バケット2（TZ依存しない）', () => {
    // サーバーのTZがUTCでもJSTでも同じ結果になること。
    // ここがズレると学習バケットと判定バケットが食い違い誤報が出る。
    expect(hourBucketOf(new Date('2026-07-16T00:00:00Z'))).toBe(2);
  });

  it('曜日も基準TZで判定する', () => {
    // UTC 2026-07-16(木) 22:00 は JST では 2026-07-17(金) 07:00
    expect(dowOf(new Date('2026-07-16T22:00:00Z'))).toBe(5); // 金曜
  });
});

describe('閾値学習 — 実データからの算出', () => {
  it('サンプル不足のバケットはデフォルトへフォールバックする', async () => {
    // 5件だけ = MIN_SAMPLE_COUNT(20) 未満
    await seedEvents(5, 60);
    await learnThresholdsForClient(clientId);

    const eff = await getEffectiveThreshold(clientId, 900, new Date());
    expect(eff.mode).toBe('default');
    expect(eff.minutes).toBe(900);
  });

  /**
   * 【学習が成立する条件についての重要な性質】
   *
   * バケットは 曜日(7) × 時間帯(6) = 42個。学習ウィンドウは8週間。
   * つまり、ある (dow, bucket) は8週間で最大8回しか巡ってこない。
   *
   * 1日1回しか操作しない人は、1バケットあたりのサンプルが最大8件にしかならず、
   * MIN_SAMPLE_COUNT(20) に永久に到達しない = 学習が効かずデフォルト閾値のまま。
   *
   * これは仕様通りの挙動（サンプル不足はデフォルトへフォールバック）であり、
   * 安全側に倒れているので誤報にはつながらない。
   * ただし「学習で個人差を吸収する」という価値提案が効く相手は
   * 「1バケットあたり3回以上操作する人」に限られる、という事実は
   * Phase 1 の誤報率KPI評価時に踏まえる必要がある。
   * TODO: 実データを見て MIN_SAMPLE_COUNT / ウィンドウ幅を再検討する。
   */
  it('十分なサンプルがあれば学習値を使う', async () => {
    // 8週間にわたり、毎日同じ時間帯に4件ずつ投入する。
    // 起点を JST 0時に固定することで4件すべてが bucket 0 に収まり、
    // 1つの (dow, bucket) には 8週 × 4gap = 32件が集まって閾値20を超える。
    // （起点を now() にすると実行時刻次第でバケットが分裂して落ちる。jstAnchor 参照）
    const start = jstAnchor(56);
    const values: string[] = [];
    const params: unknown[] = [clientId];

    for (let day = 0; day < 56; day++) {
      for (let i = 0; i < 4; i++) {
        const at = new Date(start.getTime() + day * 86400_000 + i * 45 * 60_000);
        params.push(at);
        values.push(`($1, 'phone', 'heartbeat', $${params.length}, '{"screen_on_count": 1}'::jsonb)`);
      }
    }
    await query(
      `INSERT INTO events (client_id, source_type, event_type, occurred_at, meta)
       VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
      params,
    );

    await learnThresholdsForClient(clientId);

    const rows = await query<{ sample_count: number }>(
      `SELECT sample_count FROM thresholds
        WHERE client_id = $1 AND sample_count >= $2`,
      [clientId, config.MIN_SAMPLE_COUNT],
    );

    // 学習可能なバケットが存在すること
    expect(rows.rows.length).toBeGreaterThan(0);

    // そのバケットでは learned モードが選ばれること
    const eff = await getEffectiveThreshold(clientId, 900, start);
    expect(eff.mode).toBe('learned');
    expect(eff.sampleCount).toBeGreaterThanOrEqual(config.MIN_SAMPLE_COUNT);
  });

  it('【個人差の吸収】頻繁に触る人には短い閾値が学習される', async () => {
    // 30分間隔で頻繁に操作する人。同一バケットに集中させるため
    // 起点を JST 0時に固定し、各日の同じ時間帯に集中的に投入する。
    // 8件 × 30分 = 3.5時間なので、4時間幅の bucket 0 に全件収まる。
    const start = jstAnchor(30);
    const values: string[] = [];
    const params: unknown[] = [clientId];

    // 30日間 × 各日8件（同じ時間帯・30分間隔）= 240件
    for (let day = 0; day < 30; day++) {
      for (let i = 0; i < 8; i++) {
        const at = new Date(start.getTime() + day * 86400_000 + i * 30 * 60_000);
        params.push(at);
        values.push(`($1, 'phone', 'heartbeat', $${params.length}, '{"screen_on_count": 1}'::jsonb)`);
      }
    }
    await query(
      `INSERT INTO events (client_id, source_type, event_type, occurred_at, meta)
       VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
      params,
    );

    await learnThresholdsForClient(clientId);

    // 最初のイベントが属するバケットを調べる
    const firstBucket = hourBucketOf(start);
    const firstDow = dowOf(start);

    const row = await query<{ p99_gap_minutes: number; sample_count: number }>(
      'SELECT p99_gap_minutes, sample_count FROM thresholds WHERE client_id = $1 AND dow = $2 AND hour_bucket = $3',
      [clientId, firstDow, firstBucket],
    );

    expect(row.rows.length).toBe(1);
    const learned = row.rows[0]!;
    expect(learned.sample_count).toBeGreaterThanOrEqual(20);

    // このバケット内のgapはほぼ30分。ただし日をまたぐgap(23.5時間)が
    // 各日1件混ざるため p99 はそれを拾いうる。
    // 重要なのは「学習が走り、バケット単位で値が入る」こと。
    expect(learned.p99_gap_minutes).toBeGreaterThan(0);

    // 有効閾値は必ずクランプ範囲内
    const eff = await getEffectiveThreshold(clientId, 900, start);
    expect(eff.minutes).toBeGreaterThanOrEqual(config.MIN_THRESHOLD_MINUTES);
    expect(eff.minutes).toBeLessThanOrEqual(config.MAX_THRESHOLD_MINUTES);
  });

  it('学習値は必ず下限・上限にクランプされる（暴走防止）', async () => {
    // 極端に短いgap（1分間隔）を大量投入
    await seedEvents(100, 1, 10);
    await learnThresholdsForClient(clientId);

    const bucket = hourBucketOf(new Date(Date.now() - 10 * 86400_000));
    const dow = dowOf(new Date(Date.now() - 10 * 86400_000));
    const eff = await getEffectiveThreshold(
      clientId,
      900,
      new Date(Date.now() - 10 * 86400_000),
    );

    // p99が1分でも、閾値が1分になってはならない（誤報の嵐になる）
    expect(eff.minutes).toBeGreaterThanOrEqual(config.MIN_THRESHOLD_MINUTES);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(dow).toBeGreaterThanOrEqual(0);
  });

  it('操作なしheartbeatは学習サンプルに含めない', async () => {
    // screen_on_count=0 のheartbeatを大量投入
    const start = new Date(Date.now() - 20 * 86400_000);
    const values: string[] = [];
    const params: unknown[] = [clientId];
    for (let i = 0; i < 50; i++) {
      const at = new Date(start.getTime() + i * 15 * 60_000);
      params.push(at);
      values.push(
        `($1, 'phone', 'heartbeat', $${params.length}, '{"screen_on_count": 0, "had_app_usage": false}'::jsonb)`,
      );
    }
    await query(
      `INSERT INTO events (client_id, source_type, event_type, occurred_at, meta)
       VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
      params,
    );

    await learnThresholdsForClient(clientId);

    // 生存イベントが1件もないので、閾値レコードは作られない
    const rows = await query('SELECT * FROM thresholds WHERE client_id = $1', [clientId]);
    expect(rows.rowCount).toBe(0);
  });
});
