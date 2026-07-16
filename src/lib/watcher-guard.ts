/**
 * ウォッチャー向けAPIの共通ガード（権限とプライバシーの境界）。
 *
 * 【なぜ独立モジュールに切り出すか】
 * canWatch（IDOR対策）と sendValidated（最小開示の強制）は、ウォッチャー向け
 * エンドポイントが1つでも忘れた瞬間に他人の安否情報が漏れる関数である。
 * ルートファイルごとにコピーが増えると、片方だけ直して片方が古いまま、
 * という事故が起きる。security-critical な判断は1箇所にしか置かない。
 */
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { query } from '../db/pool.js';

/**
 * ウォッチャーが対象クライアントを見る権限を持つか確認する。
 *
 * 【重要】全てのウォッチャー向けエンドポイントで必ず呼ぶこと。
 * これを忘れると、任意のクライアントIDを指定して他人の安否状態を
 * 覗ける（IDOR脆弱性）。
 *
 * 権限が無い場合、呼び出し側は 403 ではなく 404 を返すこと。
 * 403 は「そのIDのクライアントは存在する」ことを教えてしまう。
 *
 * @param watcherId - ウォッチャーID
 * @param clientId - クライアントID
 * @returns 権限があれば true
 */
export async function canWatch(watcherId: string, clientId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM watch_links WHERE watcher_id = $1 AND client_id = $2', [
    watcherId,
    clientId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * レスポンスをスキーマで検証してから返す。
 *
 * 検証に失敗した場合（＝意図しないフィールドが混入した場合）は
 * 500 を返し、データを漏らさない。
 * 「動くが情報が漏れている」より「動かない」方が安全という判断。
 *
 * @param reply - fastify reply
 * @param schema - 検証スキーマ
 * @param data - 返すデータ
 */
export function sendValidated<T>(reply: FastifyReply, schema: z.ZodType<T>, data: unknown) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    reply.log.error(
      { issues: parsed.error.issues },
      'レスポンススキーマの検証に失敗しました（情報漏洩を防ぐため500を返します）',
    );
    return reply.code(500).send({ error: 'internal_error' });
  }
  return reply.send(parsed.data);
}
