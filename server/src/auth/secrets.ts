import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * scrypt parameters. N=2^15 costs roughly 100ms and 32MB here, which is the
 * point: a password that reaches this function has already been through the
 * network, so the only defence left is making each guess expensive.
 */
const KEYLEN = 64;
const SALT_BYTES = 16;

/** `scrypt$<salt-hex>$<digest-hex>` — self-describing, so the format can change later. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const digest = await scrypt(secret, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${digest.toString('hex')}`;
}

/**
 * Constant-time check of a secret against a stored hash. A malformed or missing
 * hash is a failure, never a pass — this is the function standing between the
 * internet and a Claude session that can act on a cluster.
 */
export async function verifySecret(secret: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, digestHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !digestHex) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(digestHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;

  const actual = await scrypt(secret, Buffer.from(saltHex, 'hex'), KEYLEN);
  return timingSafeEqual(expected, actual);
}

/** Compare two strings without leaking their contents through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A session cookie value or an API key: 32 bytes, url-safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Session cookies are looked up on every request, so they are stored as a plain
 * SHA-256 rather than scrypt — a 256-bit random token has no guessing attack for
 * a slow hash to defend against, and per-request scrypt would be a denial of
 * service on ourselves.
 */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
