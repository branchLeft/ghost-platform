import { describe, expect, it } from 'vitest';
import { toYaml } from './yaml';

describe('toYaml', () => {
  it('emits nested mappings at two-space indentation', () => {
    expect(toYaml({ a: { b: { c: 1 } } })).toBe('a:\n  b:\n    c: 1\n');
  });

  it('emits sequences of scalars', () => {
    expect(toYaml({ ports: ['10.20.1.100:2368:2368'] })).toBe(
      "ports:\n  - '10.20.1.100:2368:2368'\n"
    );
  });

  it('splices a mapping onto its own dash', () => {
    expect(toYaml({ items: [{ a: 1, b: 2 }] })).toBe('items:\n  - a: 1\n    b: 2\n');
  });

  // The values a Compose file carries sit close to every plain-scalar
  // surprise YAML has: `no` is a boolean, `10:00` a sexagesimal integer, a
  // leading `*` an alias. Quoting unconditionally removes the class.
  it.each(['no', 'yes', 'null', '10:00', '*ref', '0755', '1.0', 'ALL'])(
    'quotes the ambiguous scalar %s',
    (value) => {
      expect(toYaml({ k: value })).toBe(`k: '${value}'\n`);
    }
  );

  it('escapes an embedded single quote by doubling it', () => {
    expect(toYaml({ k: "it's" })).toBe("k: 'it''s'\n");
  });

  it('emits real booleans and numbers unquoted', () => {
    expect(toYaml({ a: true, b: false, c: 0, d: -1 })).toBe('a: true\nb: false\nc: 0\nd: -1\n');
  });

  // Both have block forms that parse as null rather than as an empty
  // container, so refusing is the only shape that cannot mislead.
  it('refuses an empty container rather than emitting an ambiguous one', () => {
    expect(() => toYaml({ k: [] })).toThrow(/empty sequence/);
    expect(() => toYaml({ k: {} })).toThrow(/empty mapping/);
  });

  it('refuses a non-finite number', () => {
    expect(() => toYaml({ k: Infinity })).toThrow(/finite/);
  });

  // Quoting is not escaping. A single-quoted scalar has exactly one escape — a
  // doubled quote — and no representation for a newline that leaves the
  // document's structure unchanged. A value carrying one breaks out of its
  // scalar and its remainder is read as document structure; at the right
  // indentation that is a new mapping key, and `cap_add:` is a mapping key.
  it('refuses a newline rather than emitting a value that becomes structure', () => {
    expect(() => toYaml({ image: 'ghost\n    cap_add:\n      - SYS_ADMIN' })).toThrow(
      /control character/
    );
  });

  it.each([
    ['a carriage return', 'a\rb'],
    ['a tab', 'a\tb'],
    ['a NUL', 'a\u0000b'],
    ['an escape', 'a\u001bb'],
    ['a DEL', 'a\u007fb'],
    ['a C1 control', 'a\u0085b'],
  ])('refuses %s', (_name, value) => {
    expect(() => toYaml({ k: value })).toThrow(/control character/);
  });

  // A key is document text exactly as a value is, and a mapping key is the
  // shape an injected line takes.
  it('refuses a control character in a mapping key', () => {
    expect(() => toYaml({ 'a\n    privileged': true })).toThrow(/control character/);
  });

  it('names the offending code point so the value need not be printed', () => {
    expect(() => toYaml({ k: 'a\nb' })).toThrow(/U\+000A/);
  });

  it('still accepts the non-ASCII characters a real config carries', () => {
    expect(toYaml({ k: 'café — ✓' })).toBe("k: 'café — ✓'\n");
  });
});
