import { describe, expect, it } from 'vitest';
import { validateLeaseId } from '@branchleft/ghost-platform-render-core';
import { generateLeaseId } from '../../src/ulid.js';

describe('generateLeaseId', () => {
  it("produces a value render-core's own validateLeaseId accepts", () => {
    const id = generateLeaseId(Date.now());
    expect(() => validateLeaseId(id)).not.toThrow();
  });

  it('produces distinct ids across repeated calls at the same millisecond', () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 50 }, () => generateLeaseId(now)));
    expect(ids.size).toBe(50);
  });

  it('is deterministic given deterministic randomness, so its encoding can be checked exactly', () => {
    const id = generateLeaseId(0, () => Buffer.alloc(10, 0));
    // 48 zero-time bits and 80 zero-random bits both encode as the
    // alphabet's zero digit -- this pins the encoding itself, not just
    // "some valid-looking string".
    expect(id).toBe('0'.repeat(26));
  });
});
