/**
 * PostgreSQL 接続プールと問い合わせヘルパ。
 */
import pg from 'pg';
import { config } from '../config.js';

/**
 * timestamptz (OID 1184) と timestamp (OID 1114) を Date として受け取る。
 * pg のデフォルトもDateだが、パースをJS側で明示しておく。
 *
 * bigint (OID 20) は pg のデフォルトでは文字列で返る。
 * events.id / audit_log.id は bigserial だが、JSのNumber安全範囲
 * (2^53) を超えるのは現実的でないためNumberへ変換する。
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  // 判定ジョブ + APIリクエストの同時実行を賄う。VPS単体構成のため控えめに。
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/**
 * プール全体のエラーハンドラ。
 * これを設定しないと、アイドル接続のエラーで Node プロセスごと落ちる。
 * 見守りサービスがDBの一時的な切断で停止するのは許容できない。
 */
pool.on('error', (err) => {
  console.error('[db] アイドル接続でエラーが発生しました:', err.message);
});

/**
 * 単発クエリを実行する。
 *
 * @param text - SQL文（プレースホルダは $1, $2 形式）
 * @param params - プレースホルダにバインドする値
 * @returns クエリ結果
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * トランザクション内で処理を実行する。
 *
 * イベント投入とクライアント状態の更新は必ず同一トランザクションで行う必要がある
 * （片方だけ成功すると判定エンジンが誤った経過時間を見る）。
 *
 * @param fn - トランザクション用クライアントを受け取る処理
 * @returns fn の戻り値
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // ROLLBACK 自体の失敗で元のエラーを握り潰さないようにする
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] ROLLBACK に失敗しました:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * DBへの疎通確認。/healthz から呼ばれる。
 *
 * @returns 疎通できれば true
 */
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * プールを閉じる（グレースフルシャットダウン用）。
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
