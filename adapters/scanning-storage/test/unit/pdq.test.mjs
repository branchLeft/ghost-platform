import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const {
  digestBytes,
  pdqHashOfImage,
  decoderLoadError,
  REASON,
  MAX_IMAGE_BYTES,
} = require('../../src/pdq.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../fixtures');
const REFERENCE = path.join(FIXTURES, 'pdq-reference');
const manifest = JSON.parse(fs.readFileSync(path.join(REFERENCE, 'manifest.json'), 'utf8'));

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

function image(file) {
  return fs.readFileSync(path.join(REFERENCE, 'images', file));
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

describe('pdqHashOfImage against the reference, the images in its own pdq/data', () => {
  it('uses the images as they were recorded', () => {
    for (const entry of manifest.images) {
      const sha = crypto.createHash('sha256').update(image(entry.file)).digest('hex');
      expect(sha, entry.file).toBe(entry.sha256);
    }
  });

  it('covers the reference regression images and a spread of qualities', () => {
    const recorded = manifest.images.filter((e) => e.inReferenceRegressionExpected);
    expect(recorded.length).toBe(8);
    expect(manifest.images.some((e) => e.referenceQuality >= REFERENCE_QUALITY_FLOOR)).toBe(true);
    expect(manifest.images.some((e) => e.referenceQuality < REFERENCE_QUALITY_FLOOR)).toBe(true);
  });

  it.each(manifest.images.map((e) => [e.file, e]))(
    '%s is within the reference tolerance of the reference hash',
    async (_file, entry) => {
      const result = await pdqHashOfImage(image(entry.file));
      expect(result.reason).toBeNull();
      const mine = Buffer.from(result.hash, 'base64');
      const reference = Buffer.from(entry.referenceHex, 'hex');
      expect(mine).toHaveLength(32);
      // Below the quality floor the reference makes no promise.
      if (entry.referenceQuality >= REFERENCE_QUALITY_FLOOR) {
        expect(distance(mine, reference)).toBeLessThanOrEqual(REFERENCE_TOLERANCE);
        expect(result.quality).toBeGreaterThanOrEqual(REFERENCE_QUALITY_FLOOR);
      }
    }
  );

  it('returns the canonical base64 of exactly 32 bytes', async () => {
    const { hash } = await pdqHashOfImage(image('bridge-1-original.jpg'));
    expect(hash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(hash, 'base64').toString('base64')).toBe(hash);
  });
});

describe('control cases: the same picture, and a different one', () => {
  it('a resized and recompressed copy hashes within the match distance of the original', async () => {
    const original = image('bridge-1-original.jpg');
    const copy = await sharp(original).resize(400).jpeg({ quality: 55 }).toBuffer();
    expect(digestBytes(copy)).not.toBe(digestBytes(original));
    expect(distance(await hashOf(original), await hashOf(copy))).toBeLessThanOrEqual(
      MATCH_DISTANCE
    );
  });

  it('the reference modified copies are within the match distance of their original', async () => {
    const original = await hashOf(image('bridge-1-original.jpg'));
    expect(distance(original, await hashOf(image('shrink-a-little.jpg')))).toBeLessThanOrEqual(
      MATCH_DISTANCE
    );
  });

  it('an unrelated image is further than the match distance', async () => {
    const original = await hashOf(image('bridge-1-original.jpg'));
    for (const other of ['q0122.jpg', 'q0291.jpg', 'q2821.jpg']) {
      expect(distance(original, await hashOf(image(other))), other).toBeGreaterThan(MATCH_DISTANCE);
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

  it('hashes WebP, GIF and TIFF as well as JPEG and PNG', async () => {
    const source = await sharp(image('wee.jpg')).raw().toBuffer({ resolveWithObject: true });
    const options = { raw: { width: source.info.width, height: source.info.height, channels: 3 } };
    const jpeg = await hashOf(await sharp(source.data, options).jpeg({ quality: 95 }).toBuffer());
    for (const format of ['png', 'webp', 'gif', 'tiff']) {
      const encoded = await sharp(source.data, options)[format]().toBuffer();
      expect(distance(jpeg, await hashOf(encoded)), format).toBeLessThanOrEqual(MATCH_DISTANCE);
    }
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
      fs.readFileSync(path.join(REFERENCE, 'images', 'bridge-1-original.jpg')).subarray(0, 40),
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
