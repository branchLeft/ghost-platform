// The key an upload is asked about: a PDQ perceptual hash of the picture, the
// canonical base64 of 32 bytes, from the vendored pdq-ts pixel-to-hash port.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { asJpeg, resizedPng, texturedPng } from '../helpers/pictures';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = path.resolve(HERE, '../../src/pdq-ts');
const { pdqHashOfImage, digestBytes, REASON, MAX_IMAGE_PIXELS } = require('../../src/pdq.js') as {
  pdqHashOfImage: (
    buffer: Buffer,
    options?: { maxBytes?: number; maxPixels?: number }
  ) => Promise<{ hash: string | null; quality: number | null; reason: string | null }>;
  digestBytes: (buffer: Buffer) => string;
  REASON: Record<'EMPTY' | 'TOO_LARGE' | 'NOT_AN_IMAGE' | 'TOO_SMALL', string>;
  MAX_IMAGE_PIXELS: number;
};
const { hammingDistance, HASH_BYTES } = require('../../src/pdq-ts') as {
  hammingDistance: (a: Uint8Array, b: Uint8Array) => number;
  HASH_BYTES: number;
};

// What content-safety's `parsePdqHash` accepts (src/pdq-hash.ts there): the
// canonical base64 of exactly 32 bytes, and nothing else. Kept in step by hand;
// the hash source's own request body takes no other shape.
function acceptedByParsePdqHash(value: unknown): boolean {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value;
}

// The reference's own thresholds, for context: a match is at most 31 bits apart;
// a copy of the same picture is far closer than that.
const MATCH_DISTANCE = 31;
const SAME_PICTURE_DISTANCE = 10;

async function distance(a: Buffer, b: Buffer): Promise<number> {
  const [first, second] = await Promise.all([pdqHashOfImage(a), pdqHashOfImage(b)]);
  expect(first.hash).not.toBeNull();
  expect(second.hash).not.toBeNull();
  return hammingDistance(
    Buffer.from(first.hash as string, 'base64'),
    Buffer.from(second.hash as string, 'base64')
  );
}

describe('the vendored pdq-ts is the pinned one', () => {
  const pin = JSON.parse(readFileSync(path.join(VENDORED, 'PIN.json'), 'utf8')) as {
    commit: string;
    sha256: Record<string, string>;
  };

  it('pins a commit and a digest for every file', () => {
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pin.sha256).sort()).toEqual(
      ['LICENSE', 'NOTICE', 'dct-table.js', 'hash.js', 'index.js', 'pdq.js'].sort()
    );
  });

  it.each(['LICENSE', 'NOTICE', 'dct-table.js', 'hash.js', 'index.js', 'pdq.js'])(
    'holds %s to its recorded SHA-256',
    (file) => {
      const actual = createHash('sha256')
        .update(readFileSync(path.join(VENDORED, file)))
        .digest('hex');
      expect(actual).toBe(pin.sha256[file]);
    }
  );

  it('ships the licence and the notice of Meta, whose algorithm it is', () => {
    const licence = readFileSync(path.join(VENDORED, 'LICENSE'), 'utf8');
    const notice = readFileSync(path.join(VENDORED, 'NOTICE'), 'utf8');
    expect(licence).toMatch(/Redistribution and use in source and binary forms/);
    expect(`${licence}\n${notice}`).toMatch(/Meta Platforms, Inc\. and affiliates/);
  });
});

describe('pdqHashOfImage', () => {
  it('gives the canonical base64 of 32 bytes, which content-safety accepts', async () => {
    const result = await pdqHashOfImage(await texturedPng(1));
    expect(result.reason).toBeNull();
    expect(result.hash).not.toBeNull();
    expect(acceptedByParsePdqHash(result.hash)).toBe(true);
    expect(Buffer.from(result.hash as string, 'base64')).toHaveLength(HASH_BYTES);
  });

  it('is not a SHA-256 digest of the bytes, which content-safety refuses', async () => {
    const picture = await texturedPng(1);
    expect(acceptedByParsePdqHash(digestBytes(picture))).toBe(false);
  });

  it('is deterministic', async () => {
    const picture = await texturedPng(2);
    expect((await pdqHashOfImage(picture)).hash).toBe((await pdqHashOfImage(picture)).hash);
  });

  it('holds the hashes of the two committed pictures', async () => {
    const clean = readFileSync(path.resolve(HERE, '../fixtures/clean.png'));
    const bad = readFileSync(path.resolve(HERE, '../fixtures/bad.png'));
    expect((await pdqHashOfImage(clean)).hash).toBe('LEsRNAAAggBVSyxLETSCABE0LEsRNFVLETQsS14BETQ=');
    expect((await pdqHashOfImage(bad)).hash).toBe('ETQAABE0E6AAABE0LEsRNBE0ETSCAFVLAAAZDBE0AX4=');
  });

  it('control: a smaller copy of a picture is a near match of the original', async () => {
    const original = await texturedPng(3, 256);
    for (const side of [128, 192, 224]) {
      const copy = await resizedPng(original, side);
      // Different bytes, so a digest of them cannot match.
      expect(digestBytes(copy)).not.toBe(digestBytes(original));
      expect(await distance(original, copy)).toBeLessThanOrEqual(SAME_PICTURE_DISTANCE);
    }
  });

  it('control: an enlarged copy of a picture is still a match of the original', async () => {
    // Enlarging moves more bits than shrinking does, for the reference too; the
    // reference's own threshold for the same picture is what holds.
    const original = await texturedPng(3, 256);
    for (const side of [320, 512]) {
      expect(await distance(original, await resizedPng(original, side))).toBeLessThanOrEqual(
        MATCH_DISTANCE
      );
    }
  });

  it('control: a recompressed copy of a picture is a near match of the original', async () => {
    const original = await texturedPng(3, 256);
    expect(await distance(original, await asJpeg(original, 75))).toBeLessThanOrEqual(
      SAME_PICTURE_DISTANCE
    );
  });

  it('control: a large picture is brought to the reference size and still matches its small copy', async () => {
    const original = await texturedPng(4, 256);
    const large = await resizedPng(original, 1024);
    expect(await distance(original, large)).toBeLessThanOrEqual(MATCH_DISTANCE);
  });

  it('control: an unrelated picture is not a match', async () => {
    const one = await texturedPng(5);
    for (const seed of [6, 7, 8]) {
      expect(await distance(one, await texturedPng(seed))).toBeGreaterThan(MATCH_DISTANCE);
    }
  });
});

describe('bytes that have no hash', () => {
  const none = (reason: string) => ({ hash: null, quality: null, reason });

  it.each([
    ['nothing', Buffer.alloc(0), REASON.EMPTY],
    ['text', Buffer.from('not a picture at all'), REASON.NOT_AN_IMAGE],
    ['a template', Buffer.from('{{{body}}}'), REASON.NOT_AN_IMAGE],
    [
      'an SVG, which is a document and not a raster picture',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>'),
      REASON.NOT_AN_IMAGE,
    ],
    [
      'a PNG signature with nothing after it',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      REASON.NOT_AN_IMAGE,
    ],
  ])('gives none for %s', async (_label, bytes, reason) => {
    expect(await pdqHashOfImage(bytes)).toEqual(none(reason));
  });

  it('gives none for a truncated picture', async () => {
    const picture = await texturedPng(9);
    const result = await pdqHashOfImage(picture.subarray(0, Math.floor(picture.length / 2)));
    expect(result.hash).toBeNull();
  });

  it('gives none for something that is not a buffer', async () => {
    expect((await pdqHashOfImage('text' as unknown as Buffer)).hash).toBeNull();
    expect((await pdqHashOfImage(null as unknown as Buffer)).hash).toBeNull();
  });

  it('gives none for a picture too small to hash', async () => {
    const tiny = await texturedPng(10, 4);
    expect(await pdqHashOfImage(tiny)).toEqual(none(REASON.TOO_SMALL));
  });

  it('gives none for bytes over the size bound, and says so', async () => {
    const picture = await texturedPng(11);
    expect(await pdqHashOfImage(picture, { maxBytes: picture.length - 1 })).toEqual(
      none(REASON.TOO_LARGE)
    );
    expect((await pdqHashOfImage(picture, { maxBytes: picture.length })).hash).not.toBeNull();
  });

  it('gives none for a picture over the pixel bound, without decoding it', async () => {
    const picture = await texturedPng(12, 64);
    expect(await pdqHashOfImage(picture, { maxPixels: 64 * 64 - 1 })).toEqual(
      none(REASON.TOO_LARGE)
    );
    expect(MAX_IMAGE_PIXELS).toBeGreaterThan(0);
  });

  it('never rejects, whatever it is given', async () => {
    for (const value of [undefined, 0, {}, [], Buffer.from([0xff, 0xd8, 0xff])]) {
      await expect(pdqHashOfImage(value as unknown as Buffer)).resolves.toMatchObject({
        hash: null,
      });
    }
  });
});
