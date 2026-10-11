import { describe, expect, it } from 'vitest';
import { compareParsed } from '../src/parsedDifference.js';

describe('compareParsed', () => {
  it('names a dropped field at any depth, inside arrays too', () => {
    const sent = { a: 1, b: { c: 2, extra: 3 }, list: [{ x: 1 }, { x: 2, y: 3 }] };
    const parsed = { a: 1, b: { c: 2 }, list: [{ x: 1 }, { x: 2 }] };
    expect(compareParsed(sent, parsed)).toEqual({ unknown: ['b.extra', 'list[1].y'], altered: [] });
  });

  it('names a value the parsed copy changed, including a trimmed string', () => {
    const sent = { url: 'https://a.example ', n: { m: 'x\ty' }, list: ['p', 'q'] };
    const parsed = { url: 'https://a.example', n: { m: 'xy' }, list: ['p', 'r'] };
    expect(compareParsed(sent, parsed)).toEqual({
      unknown: [],
      altered: ['url', 'n.m', 'list[1]'],
    });
  });

  it('finds nothing when the parsed copy kept every field and value', () => {
    expect(compareParsed({ a: { b: 1 }, c: null }, { a: { b: 1 }, c: null })).toEqual({
      unknown: [],
      altered: [],
    });
    expect(compareParsed('text', 'text')).toEqual({ unknown: [], altered: [] });
    expect(compareParsed(null, null)).toEqual({ unknown: [], altered: [] });
  });
});
