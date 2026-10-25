import type { PdqHash } from './contract.js';

const PDQ_BYTES = 32;
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The only way to obtain a `PdqHash`. Anything that is not the canonical
 * base64 of exactly 32 bytes is refused here, before it can reach a request
 * body, the cache or the audit trail.
 */
export function parsePdqHash(value: unknown): PdqHash | undefined {
  if (typeof value !== 'string' || !CANONICAL_BASE64.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  // A non-zero padding remainder decodes to the same bytes as the canonical
  // form, so two spellings of one hash would cache and audit separately.
  if (bytes.length !== PDQ_BYTES || bytes.toString('base64') !== value) return undefined;
  return value as PdqHash;
}

export function isPdqHash(value: unknown): value is PdqHash {
  return parsePdqHash(value) !== undefined;
}
