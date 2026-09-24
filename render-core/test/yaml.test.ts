import { describe, expect, it } from 'vitest';
import { toYaml, type YamlValue } from '../src/yaml.js';

describe('toYaml()', () => {
  it('emits a nested array of maps with the dash-spliced first line', () => {
    const doc: YamlValue = {
      items: [{ a: 1, b: 'x' }, { a: 2 }],
    };
    expect(toYaml(doc)).toBe(['items:', '  - a: 1', "    b: 'x'", '  - a: 2', ''].join('\n'));
  });

  it('quotes a string and doubles an embedded single quote', () => {
    expect(toYaml("it's")).toBe("'it''s'\n");
  });

  it('emits booleans and numbers unquoted', () => {
    expect(toYaml(true)).toBe('true\n');
    expect(toYaml(false)).toBe('false\n');
    expect(toYaml(42)).toBe('42\n');
  });

  it('throws on a non-finite number', () => {
    expect(() => toYaml(Number.POSITIVE_INFINITY)).toThrow(/not a finite number/);
  });

  it('throws on an empty array', () => {
    expect(() => toYaml([])).toThrow(/empty sequence/);
  });

  it('throws on an empty mapping', () => {
    expect(() => toYaml({})).toThrow(/empty mapping/);
  });

  it('throws on a control character in a string value', () => {
    expect(() => toYaml('a\u0000b')).toThrow(/refusing to emit/);
  });

  it('throws on a control character in a mapping key', () => {
    expect(() => toYaml({ 'a\u0001b': 1 })).toThrow(/refusing to emit/);
  });

  it('control case: a plain string with no control character round-trips', () => {
    expect(toYaml('plain')).toBe("'plain'\n");
  });
});
