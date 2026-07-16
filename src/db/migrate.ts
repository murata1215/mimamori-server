/**
 * マイグレーション実行スクリプト。
 *
 * src/db/migrations/*.sql をファイル名順に適用し、適用済みを schema_migrations に記録する。
 * 冪等: 既に適用済みのファイルはスキップする。
 *
 * 実行: npm run migrate
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * 適用済みマイグレーションを記録するテーブルを用意する。
 */
async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 未適用のマイグレーションを順に適用する。
 *
 * 各ファイルは単一トランザクションで適用する。
 * 途中で失敗した場合、そのファイルの変更は全てロールバックされ、
 * schema_migrations にも記録されない（次回リトライ可能）。
 */
async function run(): Promise<void> {
  await ensureMigrationsTable();

  const applied = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  const appliedSet = new Set(applied.rows.map((r) => r.filename));

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`[migrate] skip (適用済み): ${file}`);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] apply: ${file}`);
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    count++;
  }

  console.log(`[migrate] 完了: ${count} 件のマイグレーションを適用しました`);
}

run()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[migrate] 失敗:', err);
    await pool.end();
    process.exit(1);
  });
