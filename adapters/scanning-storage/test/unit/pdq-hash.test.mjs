import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syntheticPixels } from '../helpers/pdq-pixels.mjs';

const require = createRequire(import.meta.url);
const { pdqFromPixels, HASH_BYTES, MIN_HASHABLE_DIM } = require('../../src/pdq-hash.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(HERE, '../fixtures/pdq-reference/pixel-cases.json'), 'utf8')
);

// The reference's own correctness test, first half: byte arrays piped into
// the C++ reference and into this port must give the same hash. The
// expected values were produced by running the reference's hashing core
// (hashing/pdqhashing.cpp, downscaling/downscaling.cpp) over these exact
// arrays; test/fixtures/pdq-reference/README.txt says how to redo it.
describe('pdqFromPixels against the C++ reference, on identical byte arrays', () => {
  it('has a meaningful set: every shape and both channel layouts', () => {
    expect(manifest.pixelCases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(manifest.pixelCases.map((c) => c.channels))).toEqual(new Set([1, 3]));
    expect(manifest.pixelCases.some((c) => c.width === 64 && c.height === 64)).toBe(true);
    expect(manifest.pixelCases.some((c) => c.kind === 'flat')).toBe(true);
  });

  it.each(manifest.pixelCases.map((c) => [c.name, c]))('%s', (_name, c) => {
    const result = pdqFromPixels(syntheticPixels(c), c.width, c.height, c.channels);
    expect(result.hash).toHaveLength(HASH_BYTES);
    expect(result.hash.toString('hex')).toBe(c.expectedHex);
    expect(result.quality).toBe(c.expectedQuality);
  });
});

describe('pdqFromPixels inputs', () => {
  it('yields no hash for a side shorter than the reference minimum, never a zero hash', () => {
    const small = MIN_HASHABLE_DIM - 1;
    expect(pdqFromPixels(Buffer.alloc(small * 50 * 3), small, 50, 3)).toBeNull();
    expect(pdqFromPixels(Buffer.alloc(50 * small), 50, small, 1)).toBeNull();
  });

  it('hashes the smallest size the reference accepts', () => {
    const pixels = syntheticPixels({ width: 5, height: 5, channels: 3, seed: 9, kind: 'blocks' });
    expect(pdqFromPixels(pixels, 5, 5, 3).hash).toHaveLength(HASH_BYTES);
  });

  it('is deterministic', () => {
    const c = { width: 90, height: 70, channels: 3, seed: 5, kind: 'blocks' };
    const a = pdqFromPixels(syntheticPixels(c), 90, 70, 3);
    const b = pdqFromPixels(syntheticPixels(c), 90, 70, 3);
    expect(a.hash.equals(b.hash)).toBe(true);
  });

  it('does not modify the pixel buffer it is given', () => {
    const c = { width: 80, height: 80, channels: 3, seed: 6, kind: 'blocks' };
    const pixels = syntheticPixels(c);
    const before = Buffer.from(pixels);
    pdqFromPixels(pixels, 80, 80, 3);
    expect(pixels.equals(before)).toBe(true);
  });

  it.each([
    ['two channels', Buffer.alloc(100), 5, 5, 2],
    ['four channels', Buffer.alloc(200), 5, 5, 4],
    ['a zero width', Buffer.alloc(100), 0, 5, 3],
    ['a fractional height', Buffer.alloc(100), 5, 5.5, 3],
    ['a buffer shorter than the dimensions say', Buffer.alloc(10), 5, 5, 3],
  ])('rejects %s', (_name, pixels, width, height, channels) => {
    expect(() => pdqFromPixels(pixels, width, height, channels)).toThrow(RangeError);
  });
});
