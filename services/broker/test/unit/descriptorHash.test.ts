import { describe, expect, it } from 'vitest';
import { descriptorHash } from '../../src/descriptorHash.js';
import { demoDescriptor } from '../helpers/fixtures.js';

describe('descriptorHash', () => {
  it('is stable for the identical descriptor', () => {
    expect(descriptorHash(demoDescriptor())).toBe(descriptorHash(demoDescriptor()));
  });

  it('is identical when only key order differs', () => {
    const a = demoDescriptor();
    // Rebuild with a deliberately different property enumeration order.
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(descriptorHash(reordered)).toBe(descriptorHash(a));
  });

  it('changes when any field changes, e.g. the gate hash (the value this endpoint rotates on every recycle)', () => {
    const a = demoDescriptor();
    const b = demoDescriptor({ gate: { kind: 'passphrase', argon2idHash: 'different-hash' } });
    expect(descriptorHash(a)).not.toBe(descriptorHash(b));
  });

  it('changes when a nested field changes', () => {
    const a = demoDescriptor();
    const b = demoDescriptor({ limits: { membersCap: 999, staffCap: 1 } });
    expect(descriptorHash(a)).not.toBe(descriptorHash(b));
  });
});
