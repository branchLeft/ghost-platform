import { createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = 'Bearer ';

/**
 * Fixed-length digest comparison: timingSafeEqual never sees buffers of
 * different length, so the token's length is not leaked either.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith(PREFIX)) {
    return false;
  }
  return constantTimeEquals(header.slice(PREFIX.length), expected);
}
