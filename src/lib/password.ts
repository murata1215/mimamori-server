/**
 * パスワードのハッシュ化と検証。
 *
 * Node標準の scrypt を使う（bcrypt等のネイティブ依存を持ち込まない方針）。
 * scrypt はメモリハードなKDFで、GPUによる総当たりに耐性がある。
 *
 * 保存形式: scrypt$N$r$p$<salt_base64>$<hash_base64>
 * パラメータを保存形式に含めることで、将来コストパラメータを上げても
 * 既存ハッシュの検証を壊さない。
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * scrypt の Promise ラッパー。
 *
 * util.promisify は scrypt のオーバーロードのうち options 付きの形を
 * 解決できないため、手書きでラップして型を保つ。
 *
 * @param password - 元になるパスワード
 * @param salt - ソルト
 * @param keylen - 導出鍵の長さ（バイト）
 * @param options - scrypt のコストパラメータ
 * @returns 導出鍵
 */
function scryptAsync(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** CPU/メモリコスト。2^15 = 32768。OWASP推奨値に準拠。 */
const N = 32768;
/** ブロックサイズ */
const R = 8;
/** 並列度 */
const P = 1;
/** 導出鍵長（バイト） */
const KEYLEN = 32;
/** ソルト長（バイト） */
const SALTLEN = 16;

/**
 * scrypt はデフォルトで N が大きいとメモリ上限エラーになるため、
 * 必要量 (128 * N * r) より十分大きい値を明示的に渡す。
 */
const MAXMEM = 128 * N * R * 2;

/**
 * パスワードをハッシュ化する。
 *
 * @param plain - 平文パスワード
 * @returns 保存用のハッシュ文字列（ソルト・パラメータを含む自己完結形式）
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALTLEN);
  const derived = await scryptAsync(plain, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * パスワードを検証する。
 *
 * 比較には timingSafeEqual を使い、タイミング攻撃を防ぐ。
 *
 * @param plain - 入力された平文パスワード
 * @param stored - DBに保存されたハッシュ文字列
 * @returns 一致すれば true。形式不正・検証失敗はすべて false（例外を投げない）
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');

    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    const derived = await scryptAsync(plain, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });

    // 長さが違うと timingSafeEqual は例外を投げるため事前に確認
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
