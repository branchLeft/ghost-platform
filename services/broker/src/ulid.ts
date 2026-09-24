import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { validateLeaseId, type LeaseId } from '@branchleft/ghost-platform-render-core';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBigIntBase32(value: bigint, chars: number): string {
  let remaining = value;
  let out = '';
  for (let i = 0; i < chars; i++) {
    const digit = CROCKFORD_BASE32[Number(remaining % 32n)];
    out = digit + out;
    remaining /= 32n;
  }
  return out;
}

/**
 * A ULID: a 48-bit millisecond timestamp (10 base32 chars) followed by
 * 80 bits of randomness (16 chars) -- monotonic-enough ordering with no
 * coordination, and `render-core`'s own `validateLeaseId` is the
 * authority on the resulting shape (this function's output is round-tripped
 * through it rather than trusted on its own construction).
 */
export function generateLeaseId(
  nowMs: number,
  randomBytes: (n: number) => Buffer = nodeRandomBytes
): LeaseId {
  const time = encodeBigIntBase32(BigInt(Math.floor(nowMs)), 10);
  const bytes = randomBytes(10);
  let randomValue = 0n;
  for (const byte of bytes) randomValue = (randomValue << 8n) | BigInt(byte);
  const random = encodeBigIntBase32(randomValue, 16);
  return validateLeaseId(time + random);
}
