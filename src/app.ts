/**
 * Fastify アプリケーションの組み立て。
 *
 * サーバー起動（listen）は index.ts が担う。
 * ここでアプリを純粋に組み立てておくことで、テストから
 * ネットワークを使わずに app.inject() で叩ける。
 */
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import jwtAuth from './auth/jwt.js';
import { config } from './config.js';
import deviceRoutes from './routes/device.js';
import healthRoutes from './routes/health.js';
import ownerRoutes from './routes/owner.js';
import pairingRoutes from './routes/pairing.js';
import sensorRoutes from './routes/sensors.js';
import watcherRoutes from './routes/watchers.js';
import watcherViewRoutes from './routes/watcher-views.js';
import webhookRoutes from './routes/webhooks.js';

/**
 * アプリを組み立てる。
 *
 * @returns 設定済みの fastify インスタンス（listen は呼ばれていない）
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      // 【重要】ログに個人情報を残さない。
      // Authorization ヘッダやリクエストボディが平文でログに出ると、
      // ログファイル自体が個人情報の漏洩経路になる。
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.lat',
          'req.body.lng',
        ],
        remove: true,
      },
      serializers: {
        // デフォルトのシリアライザはヘッダを全て出力する。
        // 必要最小限に絞る。
        req(req) {
          return { method: req.method, url: req.url };
        },
      },
    },
    // リバースプロキシ（Caddy）配下で動くため、
    // X-Forwarded-For を信頼して実クライアントIPを取得する。
    // これがないとレート制限が全リクエストを同一IPとみなし機能しない。
    trustProxy: true,
    // ボディサイズ上限。ハートビートのバッチ200件でも十分収まる。
    bodyLimit: 1_048_576, // 1MB
  });

  // --- レート制限 ---
  // グローバルのデフォルト。個別エンドポイントは routes 側で上書きする。
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // レート制限のキーはIPではなく、認証済みなら主体IDにする。
    // NAT配下の複数端末が同一IPを共有しても、互いのレート制限を
    // 食い合わないようにするため。
    keyGenerator: (req) => {
      const payload = req.user as { sub?: string } | undefined;
      return payload?.sub ?? req.ip;
    },
    // /healthz は外部監視が1分間隔で叩くため除外する。
    // ここを制限すると監視自体が誤報する。
    allowList: (req) => req.url === '/healthz' || req.url === '/livez',
  });

  // --- 認証 ---
  await app.register(jwtAuth);

  // --- ルート ---
  await app.register(healthRoutes);
  await app.register(watcherRoutes);
  await app.register(pairingRoutes);
  await app.register(deviceRoutes);
  await app.register(watcherViewRoutes);
  await app.register(ownerRoutes);
  // Phase 2: センサー管理（SwitchBot・電力メーターの紐づけ、センサーのみクライアント）
  await app.register(sensorRoutes);
  await app.register(webhookRoutes);

  // --- エラーハンドラ ---
  // 内部エラーの詳細をクライアントへ返さない（スタックトレース等の漏洩防止）。
  app.setErrorHandler((error: unknown, req, reply) => {
    const err = error as { statusCode?: number; code?: string; message?: string };
    const status = err.statusCode ?? 500;

    if (status >= 500) {
      req.log.error({ err: error }, 'リクエスト処理中にエラーが発生しました');
      return reply.code(status).send({ error: 'internal_error' });
    }

    // 4xx はクライアント側の問題なのでメッセージを返してよい
    return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not_found' });
  });

  return app;
}
