import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const KEY_LENGTH = 64;

// crypto.scrypt's callback form, promisified once at module scope rather
// than per call — promisify(fn) itself is cheap, but there is no reason to
// repeat it on every AUTH.
const scryptAsync = promisify(scrypt);

export interface HashedApiKey {
  salt: string;
  hash: string;
}

/**
 * scrypt with a per-tenant random salt, synchronous: registration is a
 * one-off CLI action, never on a request path.
 * See crypto.md#hashapikey.
 */
export function hashApiKey(apiKey: string): HashedApiKey {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(apiKey, salt, KEY_LENGTH).toString('hex');
  return { salt, hash };
}

/**
 * Async scrypt (libuv threadpool, not the event loop) — every caller is on
 * a request path (SMTP AUTH, the HTTP Basic-auth route) this service must
 * keep answering while a check is running. scryptSync here would serialise
 * every concurrent AUTH onto the single JS thread: a burst of legitimate
 * sign-ins would queue behind each other's ~20ms-plus scrypt cost even
 * though nothing about them actually conflicts.
 */
export async function verifyApiKey(apiKey: string, stored: HashedApiKey): Promise<boolean> {
  // A corrupted stored record (missing/non-string salt or hash) must fail
  // closed rather than throw — scrypt and Buffer.from both throw/reject on
  // those inputs, and an auth check that can crash on bad data is itself a
  // denial-of-service surface for that one tenant's row.
  try {
    const candidate = (await scryptAsync(apiKey, stored.salt, KEY_LENGTH)) as Buffer;
    const expected = Buffer.from(stored.hash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}
