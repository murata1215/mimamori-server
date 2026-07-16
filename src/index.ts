/**
 * サーバーのエントリポイント。
 *
 * 起動順序:
 *   1. FCM初期化（失敗してもno-opで継続）
 *   2. パーティション確保（失敗したらイベントを取りこぼすため起動を中止）
 *   3. HTTPサーバー起動
 *   4. ジョブスケジューラ起動
 *
 * 【グレースフルシャットダウン】
 * 判定ジョブの途中でプロセスが死ぬと、状態遷移は記録されたが通知が飛んでいない、
 * という中途半端な状態が残りうる。SIGTERM を受けたらジョブを止め、
 * 進行中のリクエストを捌き切ってから終了する。
 */
import { buildApp } from './app.js';
import { config } from './config.js';
import { closePool, query } from './db/pool.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { initFcm } from './notify/fcm.js';

/**
 * サーバーを起動する。
 */
async function main(): Promise<void> {
  console.log(`[boot] mimamori-server を起動しています (env: ${config.NODE_ENV})`);

  // --- 1. FCM 初期化 ---
  // 失敗してもno-opドライバで継続する（判定エンジンは動かし続ける）
  await initFcm();

  // --- 2. パーティション確保 ---
  // 【重要】ここが失敗した状態で起動してはならない。
  // 該当パーティションが無いとイベントのINSERTが失敗し、
  // ハートビートを取りこぼす = 見守りが機能しない。
  try {
    await query('SELECT ensure_event_partitions()');
    console.log('[boot] events のパーティションを確認しました');
  } catch (err) {
    console.error(
      '[boot] パーティションの確保に失敗しました。' +
        'この状態で起動するとイベントを取りこぼすため中止します:',
      err,
    );
    process.exit(1);
  }

  // --- 3. HTTPサーバー起動 ---
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    console.log(`[boot] HTTPサーバーが起動しました: http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    console.error('[boot] HTTPサーバーの起動に失敗しました:', err);
    process.exit(1);
  }

  // --- 4. ジョブスケジューラ起動 ---
  // HTTPサーバーの後に起動する。
  // 判定ジョブが通知を送る前に /healthz が応答できる状態にしておきたいため。
  await startScheduler();

  console.log('[boot] 起動が完了しました');

  // --- グレースフルシャットダウン ---
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // 二重シャットダウンを防ぐ（SIGTERM の後に SIGINT が来る等）
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[shutdown] ${signal} を受信しました。終了処理を開始します`);

    // 新しい判定ジョブが始まらないよう先に止める
    await stopScheduler().catch((err) =>
      console.error('[shutdown] ジョブの停止に失敗しました:', err),
    );

    // 進行中のリクエストを捌き切ってからサーバーを閉じる
    await app.close().catch((err) =>
      console.error('[shutdown] サーバーの停止に失敗しました:', err),
    );

    await closePool().catch((err) =>
      console.error('[shutdown] DBプールの停止に失敗しました:', err),
    );

    console.log('[shutdown] 終了処理が完了しました');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 未処理の例外・Promise拒否でプロセスが黙って死ぬのを防ぐ。
  // 見守りサービスが理由不明で停止するのは最悪のケース。
  // ログに残した上で終了し、systemd による自動再起動に委ねる。
  process.on('uncaughtException', (err) => {
    console.error('[fatal] 未処理の例外が発生しました:', err);
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] 未処理のPromise拒否が発生しました:', reason);
    void shutdown('unhandledRejection');
  });
}

main().catch((err) => {
  console.error('[boot] 起動に失敗しました:', err);
  process.exit(1);
});
