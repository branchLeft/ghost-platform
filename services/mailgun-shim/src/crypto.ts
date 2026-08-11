import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

export interface HashedApiKey {
  salt: string;
  hash: string;
}

/**
 * scrypt with a per-tenant random salt, not a bare fast hash — CodeQL
 * (js/insufficient-password-hash) correctly flags a fast digest here even
 * though an API key's entropy comes from randomness rather than a human
 * picking it: the lookup-by-domain-then-verify shape below means nothing
 * about this being a "password field" changes just because we're confident
 * the input is high-entropy, and a proper KDF costs nothing at this call
 * volume.
 */
export function hashApiKey(apiKey: string): HashedApiKey {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(apiKey, salt, KEY_LENGTH).toString('hex');
  return { salt, hash };
}

export function verifyApiKey(apiKey: string, stored: HashedApiKey): boolean {
  const candidate = scryptSync(apiKey, stored.salt, KEY_LENGTH);
  const expected = Buffer.from(stored.hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
