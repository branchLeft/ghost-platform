import { ESTATE_LOCATION } from '@branchleft/hetzner-host';
import { describe, expect, it } from 'vitest';

import { assertColocatedWithEdge } from './locationCheck';

describe('assertColocatedWithEdge', () => {
  it('returns the address-plan location when edge1 is applied there', () => {
    expect(assertColocatedWithEdge(ESTATE_LOCATION)).toBe(ESTATE_LOCATION);
  });

  it('throws on a mismatch, naming both locations', () => {
    expect(() => assertColocatedWithEdge('hel1')).toThrowError(/hel1/);
    expect(() => assertColocatedWithEdge('hel1')).toThrowError(new RegExp(ESTATE_LOCATION));
  });

  it('rejects an empty value rather than treating it as a match', () => {
    expect(() => assertColocatedWithEdge('')).toThrowError();
  });

  // `requireOutput(...).apply(String)` upstream can hand over the string
  // 'undefined' if the output shape ever changes; that must fail, not place
  // hosts.
  it("rejects the string 'undefined'", () => {
    expect(() => assertColocatedWithEdge('undefined')).toThrowError();
  });
});
