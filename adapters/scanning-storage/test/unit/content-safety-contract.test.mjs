import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePdqHash, isPdqHash } from '../fixtures/content-safety/pdq-hash.ts';

const require = createRequire(import.meta.url);
const { pdqHashOfImage, digestBytes } = require('../../src/pdq.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../fixtures');
const recorded = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'content-safety/recorded-hashes.json'), 'utf8')
);

// sha256 of src/pdq-hash.ts in branchLeft/content-safety at the commit named
// in recorded-hashes.json (see the README beside the copy).
const CONTENT_SAFETY_PDQ_HASH_SHA256 =
  '98476226baf42afca604c529824ae67e4f37189f14a4d2b9f318a3f83aabd38b';

function fixtureBytes(name) {
  const generated = path.join(FIXTURES, 'pdq-generated', name);
  return fs.readFileSync(fs.existsSync(generated) ? generated : path.join(FIXTURES, name));
}

describe('what content-safety accepts as a PDQ hash', () => {
  it('is tested against an unmodified copy of its parser', () => {
    const copy = fs.readFileSync(path.join(FIXTURES, 'content-safety/pdq-hash.ts'));
    expect(crypto.createHash('sha256').update(copy).digest('hex')).toBe(
      CONTENT_SAFETY_PDQ_HASH_SHA256
    );
    expect(recorded.contentSafety.commit).toBe('48a1e79e810e361c1b04e7a0322f44372b833c9f');
  });

  it('accepts the hash computed for every recorded image, and computes the recorded value', async () => {
    const names = Object.keys(recorded.hashes);
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const name of names) {
      const { hash } = await pdqHashOfImage(fixtureBytes(name));
      expect(parsePdqHash(hash), name).toBe(hash);
      expect(isPdqHash(hash), name).toBe(true);
      expect(hash, name).toBe(recorded.hashes[name]);
    }
  });

  it('control: the SHA-256 digest the adapter used to ask about is refused', () => {
    const standIn = digestBytes(fixtureBytes('clean.png'));
    expect(standIn).toMatch(/^[0-9a-f]{64}$/);
    expect(parsePdqHash(standIn)).toBeUndefined();
    expect(isPdqHash(standIn)).toBe(false);
  });

  it('control: the same hash as hex, or cut short, is refused', async () => {
    const { hash } = await pdqHashOfImage(fixtureBytes('clean.png'));
    expect(parsePdqHash(Buffer.from(hash, 'base64').toString('hex'))).toBeUndefined();
    expect(parsePdqHash(hash.slice(0, 40))).toBeUndefined();
  });
});
