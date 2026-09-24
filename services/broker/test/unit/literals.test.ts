import { describe, expect, it } from 'vitest';
import { validateColour, validateSlotLiteral } from '../../src/literals.js';

const SEVEN = ['0', '1', '2', '3', '4', '5', '6'];

describe('validateSlotLiteral', () => {
  it('accepts every literal in the enumerated set', () => {
    for (const slot of SEVEN) {
      expect(validateSlotLiteral(slot, SEVEN)).toBe(slot);
    }
  });

  it('refuses a shape-valid slot name outside the enumerated set', () => {
    expect(() => validateSlotLiteral('7', SEVEN)).toThrow(/not one of the enumerated/);
    expect(() => validateSlotLiteral('demo-1', SEVEN)).toThrow();
  });

  it('refuses a non-string value', () => {
    expect(() => validateSlotLiteral(0, SEVEN)).toThrow();
    expect(() => validateSlotLiteral(undefined, SEVEN)).toThrow();
    expect(() => validateSlotLiteral(['0'], SEVEN)).toThrow();
  });

  it('refuses a value shaped to smuggle a second argument past a naive check', () => {
    // The exact shape workspace#1188's review reproduced against real sudo:
    // one string holding a space, which downstream code must never treat
    // as an already-split pair of tokens.
    expect(() => validateSlotLiteral('0 reset', SEVEN)).toThrow();
    expect(() => validateSlotLiteral('0/../1', SEVEN)).toThrow();
  });
});

describe('validateColour', () => {
  it('accepts exactly "a" and "b"', () => {
    expect(validateColour('a')).toBe('a');
    expect(validateColour('b')).toBe('b');
  });

  it('refuses anything else', () => {
    expect(() => validateColour('c')).toThrow();
    expect(() => validateColour('')).toThrow();
    expect(() => validateColour('a b')).toThrow();
  });
});
