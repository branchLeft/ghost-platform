import { describe, expect, it } from 'vitest';
import { assertDrained, UndrainedColourError } from '../../src/drainGate.js';
import type { DrainFlag } from '../../src/drainFlag.js';

function fakeFlag(isSet: boolean): DrainFlag {
  return { isSet: () => isSet };
}

describe('assertDrained', () => {
  it('passes silently when the flag is set', () => {
    expect(() => assertDrained(fakeFlag(true), 'tenant-a-export-1')).not.toThrow();
  });

  it('refuses with UndrainedColourError when the flag is not set', () => {
    expect(() => assertDrained(fakeFlag(false), 'tenant-a-export-1')).toThrow(UndrainedColourError);
  });

  it("names the colour in the error, so a refusal is actionable, not just 'no'", () => {
    try {
      assertDrained(fakeFlag(false), 'tenant-a-export-1');
      throw new Error('expected assertDrained to throw');
    } catch (err) {
      expect((err as Error).message).toContain('tenant-a-export-1');
    }
  });
});
