import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { digestBytes } = require('../../src/pdq.js');

describe('digestBytes', () => {
  it('is deterministic for the same bytes', () => {
    const a = digestBytes(Buffer.from('hello'));
    const b = digestBytes(Buffer.from('hello'));
    expect(a).toBe(b);
  });

  it('differs for different bytes', () => {
    const a = digestBytes(Buffer.from('hello'));
    const b = digestBytes(Buffer.from('goodbye'));
    expect(a).not.toBe(b);
  });

  it('is safe to use as a filename', () => {
    const digest = digestBytes(Buffer.from('anything'));
    expect(digest).toMatch(/^[a-f0-9]+$/);
  });
});
