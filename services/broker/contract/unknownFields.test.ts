import { describe, expect, it } from 'vitest';
import { unknownFieldPaths } from '../src/unknownFields.js';

describe('unknownFieldPaths', () => {
  it('names a dropped field at any depth, inside arrays too', () => {
    const sent = { a: 1, b: { c: 2, extra: 3 }, list: [{ x: 1 }, { x: 2, y: 3 }] };
    const parsed = { a: 1, b: { c: 2 }, list: [{ x: 1 }, { x: 2 }] };
    expect(unknownFieldPaths(sent, parsed)).toEqual(['b.extra', 'list[1].y']);
  });

  it('finds nothing when the parsed copy kept every field, or the shapes are not records', () => {
    expect(unknownFieldPaths({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
    expect(unknownFieldPaths('text', 'text')).toEqual([]);
    expect(unknownFieldPaths(null, null)).toEqual([]);
  });
});
