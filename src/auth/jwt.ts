/**
 * JWT 認証プラグインと認可ガード。
 *
 * トークンは2系統:
 *   - watcher: ログインで発行（access / refresh 方式）
 *   - device : ペアリング時に発行される長期デバイストークン
 *
 * 【重要】role をトークンに埋め、ガードで必ず検証する。
 * クライアント端末のトークンでウォッチャーAPIを叩けてはならない
 * （逆も同様）。両者は見える情報のレベルが根本的に違う。
 */
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { query as dbQuery } from '../db/pool.js';

/** ウォッチャー用トークンのペイロード */
export interface WatcherTokenPayload {
  role: 'watcher';
  sub: string;          // watcher_id
  typ: 'access' | 'refresh';
}

/** クライアント端末用トークンのペイロード */
export interface DeviceTokenPayload {
  role: 'device';
  sub: string;          // client_id
  device_id: string;
}

export type TokenPayload = WatcherTokenPayload | DeviceTokenPayload;

declare module 'fastify' {
  interface FastifyInstance {
    /** ウォッチャー権限を要求する preHandler */
    requireWatcher: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** クライアント端末権限を要求する preHandler */
    requireDevice: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** 認証済みウォッチャーID（requireWatcher 通過後に設定される） */
    watcherId?: string;
    /** 認証済みクライアントID（requireDevice 通過後に設定される） */
    clientId?: string;
    /** 認証済みデバイスID（requireDevice 通過後に設定される） */
    deviceId?: string;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload;
  }
}

/**
 * JWT プラグイン本体。
 * 認証ガードを fastify インスタンスに登録する。
 */
async function jwtPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    // アルゴリズムを明示的に固定する。
    // 指定しないと "alg: none" やアルゴリズム混同攻撃の余地が生まれる。
    sign: { algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });

  /**
   * ウォッチャー権限ガード。
   * access トークンのみ通す（refresh トークンでAPIを叩けてはならない）。
   */
  app.decorate('requireWatcher', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await req.jwtVerify<TokenPayload>();
      if (payload.role !== 'watcher' || payload.typ !== 'access') {
        return reply.code(403).send({ error: 'forbidden', message: 'ウォッチャー権限が必要です' });
      }
      req.watcherId = payload.sub;
    } catch {
      return reply.code(401).send({ error: 'unauthorized', message: '認証が必要です' });
    }
  });

  /**
   * クライアント端末ガード。
   *
   * JWT 検証に加え、デバイスが無効化されていないことを確認する。
   * 機種変更で login した際に旧デバイスは deactivated_at が設定されるため、
   * 旧端末のJWTは即座に無効になる。
   *
   * 【なぜ DB 参照が必要か】
   * JWT は取り消せない（ステートレス）。旧端末が confirm_alive を送ると
   * ALIVE 誤復帰し、死亡を見逃す（絶対ルール1違反）。
   * 1クエリの追加コストより correctness を優先する。
   */
  app.decorate('requireDevice', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await req.jwtVerify<TokenPayload>();
      if (payload.role !== 'device') {
        return reply.code(403).send({ error: 'forbidden', message: 'デバイス権限が必要です' });
      }

      // デバイスが無効化されていないことを確認
      const active = await dbQuery(
        'SELECT 1 FROM devices WHERE id = $1 AND deactivated_at IS NULL',
        [payload.device_id],
      );
      if (active.rowCount === 0) {
        return reply.code(401).send({
          error: 'device_deactivated',
          message: 'このデバイスは無効化されています。新しい端末でログインしてください',
        });
      }

      req.clientId = payload.sub;
      req.deviceId = payload.device_id;
    } catch {
      return reply.code(401).send({ error: 'unauthorized', message: '認証が必要です' });
    }
  });
}

export default fp(jwtPlugin, { name: 'jwt-auth' });

/**
 * ウォッチャー用のアクセストークンとリフレッシュトークンを発行する。
 *
 * @param app - fastify インスタンス（署名に使う）
 * @param watcherId - ウォッチャーID
 * @returns アクセストークンとリフレッシュトークン
 */
export function issueWatcherTokens(
  app: FastifyInstance,
  watcherId: string,
): { access_token: string; refresh_token: string } {
  const access_token = app.jwt.sign(
    { role: 'watcher', sub: watcherId, typ: 'access' } satisfies WatcherTokenPayload,
    { expiresIn: config.JWT_ACCESS_TTL },
  );
  const refresh_token = app.jwt.sign(
    { role: 'watcher', sub: watcherId, typ: 'refresh' } satisfies WatcherTokenPayload,
    { expiresIn: config.JWT_REFRESH_TTL },
  );
  return { access_token, refresh_token };
}

/**
 * クライアント端末用のデバイストークンを発行する。
 *
 * 端末は「一度設定したら二度と触らない」のが理想のため長期トークンとする。
 *
 * @param app - fastify インスタンス
 * @param clientId - クライアントID
 * @param deviceId - デバイスID
 * @returns デバイストークン
 */
export function issueDeviceToken(
  app: FastifyInstance,
  clientId: string,
  deviceId: string,
): string {
  return app.jwt.sign(
    { role: 'device', sub: clientId, device_id: deviceId } satisfies DeviceTokenPayload,
    { expiresIn: config.JWT_DEVICE_TTL },
  );
}
