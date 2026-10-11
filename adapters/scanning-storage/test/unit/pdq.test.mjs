import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { pictures } from '../fixtures/pdq-generated/generate.mjs';

const require = createRequire(import.meta.url);
const {
  digestBytes,
  pdqHashOfImage,
  decoderLoadError,
  REASON,
  MAX_IMAGE_BYTES,
  REFERENCE_SIDE,
} = require('../../src/pdq.js');
const { pdqFromPixels } = require('../../src/pdq-hash.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../fixtures');
const GENERATED = path.join(FIXTURES, 'pdq-generated');
const manifest = JSON.parse(fs.readFileSync(path.join(GENERATED, 'manifest.json'), 'utf8'));

// The reference's tolerances, from its README: two hashes whose quality is
// at least 80 are "within distance 10" of the reference's own; a distance of
// 31 or less is its suggested starting point for "the same picture".
const REFERENCE_TOLERANCE = 10;
const REFERENCE_QUALITY_FLOOR = 80;
const MATCH_DISTANCE = 31;

function distance(a, b) {
  let bits = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = a[i] ^ b[i];
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

function picture(file) {
  return fs.readFileSync(path.join(GENERATED, file));
}

function entryFor(file) {
  const entry = manifest.pictures.find((e) => e.file === file);
  expect(entry, file).toBeDefined();
  return entry;
}

async function hashOf(buffer) {
  const result = await pdqHashOfImage(buffer);
  expect(result.reason).toBeNull();
  return Buffer.from(result.hash, 'base64');
}

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

describe('the generated pictures', () => {
  it('are the files the manifest recorded', () => {
    expect(manifest.pictures.length).toBeGreaterThanOrEqual(15);
    for (const entry of manifest.pictures) {
      const sha = crypto.createHash('sha256').update(picture(entry.file)).digest('hex');
      expect(sha, entry.file).toBe(entry.sha256);
    }
  });

  it('name the reference commit and the generator seed', () => {
    expect(manifest.reference.commit).toBe('bd0108ff1745135a421856586d19d820dd62c6de');
    expect(manifest.generator.seed).toBeGreaterThan(0);
  });

  it('decode, when lossless, to exactly the pixels the generator computes', async () => {
    for (const spec of pictures().filter((s) => s.lossless)) {
      const { data, info } = await sharp(picture(spec.file))
        .removeAlpha()
        .toColourspace(spec.channels === 1 ? 'b-w' : 'srgb')
        .raw({ depth: 'uchar' })
        .toBuffer({ resolveWithObject: true });
      expect([info.width, info.height, info.channels], spec.file).toEqual([
        spec.width,
        spec.height,
        spec.channels,
      ]);
      expect(data.equals(spec.pixels), spec.file).toBe(true);
    }
  });
});

// The reference's own correctness test, second half: images decoded by the
// real decoder are within distance 10 of the reference's hash when its
// quality is at least 80. Where the picture is lossless and needs no
// shrinking the decoded pixels are the generator's, so the hash is identical.
describe('pdqHashOfImage against the reference, on generated pictures', () => {
  it.each(manifest.pictures.map((e) => [e.file, e]))('%s', async (_file, entry) => {
    const result = await pdqHashOfImage(picture(entry.file));
    expect(result.reason).toBeNull();
    const mine = Buffer.from(result.hash, 'base64');
    const reference = Buffer.from(entry.referenceHex, 'hex');
    expect(mine).toHaveLength(32);
    expect(result.quality).toBe(entry.referenceQuality);
    const exact = entry.lossless && Math.max(entry.width, entry.height) <= REFERENCE_SIDE;
    if (exact) {
      expect(distance(mine, reference)).toBe(0);
    } else if (entry.referenceQuality >= REFERENCE_QUALITY_FLOOR) {
      expect(distance(mine, reference)).toBeLessThanOrEqual(REFERENCE_TOLERANCE);
    }
  });

  it('covers every format, a shrunk picture, a flat one and both sides of both quality marks', () => {
    const formats = new Set(manifest.pictures.map((e) => e.format));
    expect(formats).toEqual(new Set(['png', 'jpg', 'gif', 'webp']));
    expect(manifest.pictures.some((e) => Math.max(e.width, e.height) > REFERENCE_SIDE)).toBe(true);
    const qualities = manifest.pictures.map((e) => e.referenceQuality);
    expect(qualities).toContain(0);
    expect(qualities.some((q) => q === 49)).toBe(true);
    expect(qualities.some((q) => q === 54)).toBe(true);
    expect(qualities.some((q) => q === 77)).toBe(true);
    expect(qualities.some((q) => q === 82)).toBe(true);
  });

  it('a picture the reference gives quality 0 hashes to the reference value', async () => {
    const entry = entryFor('flat-64x64.png');
    expect(entry.referenceQuality).toBe(0);
    expect((await pdqHashOfImage(picture(entry.file))).quality).toBe(0);
  });

  it('the photo hasher and the core agree on every lossless picture of 512 px or less', () => {
    const both = manifest.pictures.filter((e) => e.coreOnGeneratorPixelsHex);
    expect(both.length).toBeGreaterThanOrEqual(10);
    for (const e of both) {
      expect(e.coreOnGeneratorPixelsHex, e.file).toBe(e.referenceHex);
    }
  });

  it('shrinks by a smooth filter because nearest neighbour is further from the reference', async () => {
    const entry = entryFor('bilevel-1600x1000.png');
    const reference = Buffer.from(entry.referenceHex, 'hex');
    const smooth = await hashOf(picture(entry.file));
    const { data, info } = await sharp(picture(entry.file))
      .resize(REFERENCE_SIDE, REFERENCE_SIDE, {
        fit: 'fill',
        kernel: 'nearest',
        fastShrinkOnLoad: false,
      })
      .toColourspace('b-w')
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
    const nearest = pdqFromPixels(data, info.width, info.height, info.channels).hash;
    expect(distance(smooth, reference)).toBeLessThanOrEqual(REFERENCE_TOLERANCE);
    expect(distance(nearest, reference)).toBeGreaterThan(REFERENCE_TOLERANCE);
  });

  it('returns the canonical base64 of exactly 32 bytes', async () => {
    const { hash } = await pdqHashOfImage(picture('scene-a-480x360.jpg'));
    expect(hash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(hash, 'base64').toString('base64')).toBe(hash);
  });
});

describe('control cases: the same picture, and a different one', () => {
  it('the resized and recompressed copy is a different file within the match distance', async () => {
    const original = picture('scene-a-480x360.jpg');
    const copy = picture('scene-a-small-240x180.jpg');
    expect(digestBytes(copy)).not.toBe(digestBytes(original));
    expect(distance(await hashOf(original), await hashOf(copy))).toBeLessThanOrEqual(
      MATCH_DISTANCE
    );
  });

  it('a copy resized and recompressed here is within the match distance of the large original', async () => {
    const original = picture('scene-a-large-1280x960.jpg');
    const copy = await sharp(original).resize(420).jpeg({ quality: 50 }).toBuffer();
    expect(digestBytes(copy)).not.toBe(digestBytes(original));
    expect(distance(await hashOf(original), await hashOf(copy))).toBeLessThanOrEqual(
      MATCH_DISTANCE
    );
  });

  it('an unrelated picture is further than the match distance', async () => {
    const original = await hashOf(picture('scene-a-480x360.jpg'));
    for (const other of ['scene-b-256x192.png', 'scene-c-256x192.gif', 'bilevel-1600x1000.png']) {
      expect(distance(original, await hashOf(picture(other))), other).toBeGreaterThan(
        MATCH_DISTANCE
      );
    }
  });

  it('the two fixture images the adapter tests use are not near each other', async () => {
    const clean = await hashOf(fs.readFileSync(path.join(FIXTURES, 'clean.png')));
    const bad = await hashOf(fs.readFileSync(path.join(FIXTURES, 'bad.png')));
    expect(distance(clean, bad)).toBeGreaterThan(MATCH_DISTANCE);
  });
});

describe('what is hashed', () => {
  async function raw(width, height, channels, fill) {
    const data = Buffer.alloc(width * height * channels);
    for (let i = 0; i < data.length; i += 1) data[i] = fill(i);
    return { data, options: { raw: { width, height, channels } } };
  }

  it('ignores transparency and EXIF orientation: the stored pixels are hashed', async () => {
    const { data, options } = await raw(96, 80, 3, (i) => (i * 7) & 255);
    const plain = await sharp(data, options).jpeg().toBuffer();
    const tagged = await sharp(data, options).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(tagged.equals(plain)).toBe(false);
    expect((await pdqHashOfImage(tagged)).hash).toBe((await pdqHashOfImage(plain)).hash);

    const rgba = await sharp(data, options).ensureAlpha(0.2).png().toBuffer();
    const rgb = await sharp(data, options).png().toBuffer();
    expect((await pdqHashOfImage(rgba)).hash).toBe((await pdqHashOfImage(rgb)).hash);
  });

  it('hashes a grey image and its RGB copy to the same hash or within two bits', async () => {
    const grey = await raw(120, 90, 1, (i) => ((i % 120) * 2 + Math.floor(i / 120)) & 255);
    const rgb = Buffer.alloc(120 * 90 * 3);
    for (let i = 0; i < grey.data.length; i += 1) rgb.fill(grey.data[i], i * 3, i * 3 + 3);
    const greyPng = await sharp(grey.data, grey.options).png().toBuffer();
    const rgbPng = await sharp(rgb, { raw: { width: 120, height: 90, channels: 3 } })
      .png()
      .toBuffer();
    expect(distance(await hashOf(greyPng), await hashOf(rgbPng))).toBeLessThanOrEqual(2);
  });

  it('hashes TIFF as well as the formats the generated pictures cover', async () => {
    const source = await sharp(picture('scene-a-256x192.png'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const options = { raw: { width: source.info.width, height: source.info.height, channels: 3 } };
    const png = await hashOf(await sharp(source.data, options).png().toBuffer());
    const tiff = await hashOf(
      await sharp(source.data, options).tiff({ compression: 'lzw' }).toBuffer()
    );
    expect(distance(png, tiff)).toBe(0);
  });
});

describe('bytes that are not a hashable image yield no hash', () => {
  it.each([
    ['empty bytes', Buffer.alloc(0), REASON.EMPTY],
    ['a string, not bytes', 'not a buffer', REASON.EMPTY],
    ['plain text', Buffer.from('hello, this is not a picture'), REASON.NOT_AN_IMAGE],
    ['random bytes', crypto.randomBytes(4096), REASON.NOT_AN_IMAGE],
    [
      'an SVG, which is a vector document',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>'
      ),
      REASON.NOT_AN_IMAGE,
    ],
    [
      'a PNG signature and nothing else',
      Buffer.from('89504e470d0a1a0a', 'hex'),
      REASON.NOT_AN_IMAGE,
    ],
    [
      'a JPEG cut off after its header',
      picture('scene-a-480x360.jpg').subarray(0, 40),
      REASON.NOT_AN_IMAGE,
    ],
  ])('%s', async (_name, bytes, reason) => {
    const result = await pdqHashOfImage(bytes);
    expect(result).toEqual({ hash: null, quality: null, reason });
  });

  it('a picture shorter than the reference minimum has no hash', async () => {
    const tiny = await sharp({
      create: { width: 4, height: 40, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    expect(await pdqHashOfImage(tiny)).toEqual({
      hash: null,
      quality: null,
      reason: REASON.TOO_SMALL,
    });
  });

  it('bytes over the size bound have no hash, and the bound is generous', async () => {
    const png = fs.readFileSync(path.join(FIXTURES, 'clean.png'));
    expect(MAX_IMAGE_BYTES).toBeGreaterThan(10 * 1024 * 1024);
    expect(await pdqHashOfImage(png, { maxBytes: png.length - 1 })).toMatchObject({
      hash: null,
      reason: REASON.TOO_LARGE,
    });
    expect((await pdqHashOfImage(png, { maxBytes: png.length })).hash).not.toBeNull();
  });

  it('a picture over the pixel bound has no hash, without being decoded', async () => {
    const png = fs.readFileSync(path.join(FIXTURES, 'clean.png'));
    expect(await pdqHashOfImage(png, { maxPixels: 64 * 64 - 1 })).toMatchObject({
      hash: null,
      reason: REASON.TOO_LARGE,
    });
  });

  it('a huge canvas under both bounds is hashed by shrinking it, not by holding it whole', async () => {
    const wide = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    expect((await pdqHashOfImage(wide)).hash).not.toBeNull();
  });
});

describe('without the decoder', () => {
  it('has the decoder in this environment', () => {
    expect(decoderLoadError()).toBeNull();
  });
});
