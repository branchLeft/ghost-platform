import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { pdqHashOfImage } = require('../../src/pdq.js');
const { patternedPng } = require('../helpers/patterned-png.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../fixtures');

// The image tests run with no install, so they cannot decode a picture; they
// read the keys recorded here and these tests keep the record honest.
describe('the verdict keys the image tests rely on', () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'verdict-keys.json'), 'utf8'));

  it.each(Object.entries(recorded.keys))('%s matches the decoder', async (sha, entry) => {
    const bytes = fs.readFileSync(path.join(FIXTURES, entry.file));
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(sha);
    expect((await pdqHashOfImage(bytes)).hash).toBe(entry.key);
  });

  it('the generated pictures hash, through the decoder, to the key they were made with', async () => {
    for (const seed of [11, 77, 4242]) {
      const { png, key } = patternedPng(seed);
      expect((await pdqHashOfImage(png)).hash).toBe(key);
    }
  });

  it('different seeds give different pictures', () => {
    expect(patternedPng(1).key).not.toBe(patternedPng(2).key);
  });

  it('can make a picture over the multipart threshold that the decoder still hashes', async () => {
    // Over 512 pixels the decoder shrinks first, so the recorded key does not
    // apply; only that it is hashed matters to the image test that uses it.
    const { png } = patternedPng(5, { width: 1800, height: 1200, block: 1 });
    expect(png.length).toBeGreaterThan(5 * 1024 * 1024 + 1024);
    expect((await pdqHashOfImage(png)).hash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  }, 30_000);
});
