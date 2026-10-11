// Generates every picture the PDQ tests use. Nothing here is a photograph or
// third-party artwork: each picture is computed from the formulas below with a
// fixed seed, so the files in this directory can be rebuilt at any time.
//
//   node generate.mjs            writes the pictures next to this file
//   node generate.mjs --verify   checks the committed lossless files decode to
//                                exactly the generated pixels
//
// The expected hashes are not produced here: `record-reference.mjs` asks the
// reference implementation for them (see README.txt).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// One seed for the whole set; each picture derives its own from it.
export const SEED = 20261011;

function lcg(seed) {
  let state = (SEED ^ seed) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function rgb(width, height, fn) {
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fn(x / width, y / height, x, y);
      const o = (y * width + x) * 3;
      px[o] = clamp(r);
      px[o + 1] = clamp(g);
      px[o + 2] = clamp(b);
    }
  }
  return px;
}

// Smooth colour gradients, a disc, a rectangle and a diagonal band, with a
// little seeded noise so JPEG and PNG have something to do.
export function sceneGradientShapes(width, height, noiseAmplitude = 4) {
  const noise = lcg(1);
  return rgb(width, height, (u, v) => {
    let r = 40 + 170 * u;
    let g = 60 + 120 * v;
    let b = 210 - 110 * (u + v) * 0.5;
    const du = u - 0.3;
    const dv = (v - 0.4) * (height / width);
    if (du * du + dv * dv < 0.04) {
      r += 60;
      g += 50;
      b -= 40;
    }
    if (u > 0.6 && u < 0.85 && v > 0.55 && v < 0.8) {
      r *= 0.45;
      g *= 0.45;
      b *= 0.6;
    }
    if (Math.abs(u - v * 0.8 - 0.1) < 0.03) {
      r = 235;
      g = 235;
      b = 235;
    }
    const n = (noise() % (2 * noiseAmplitude + 1)) - noiseAmplitude;
    return [r + n, g + n, b + n];
  });
}

// Concentric rings and stripes: a different picture, with unrelated structure.
export function sceneRingsStripes(width, height) {
  return rgb(width, height, (u, v) => {
    const du = u - 0.62;
    const dv = (v - 0.35) * (height / width);
    const ring = Math.sin(Math.sqrt(du * du + dv * dv) * 70);
    const stripe = Math.sin((u * 9 - v * 5) * Math.PI);
    return [128 + 100 * ring, 120 + 90 * stripe, 140 - 80 * ring * stripe];
  });
}

const PALETTE = [
  [240, 240, 240],
  [20, 30, 90],
  [200, 40, 40],
  [40, 160, 80],
  [240, 190, 30],
  [120, 60, 160],
  [30, 30, 30],
  [90, 190, 220],
];

// Flat colours from an eight-colour palette: exact in a GIF and in lossless
// WebP, so the reference core can be given the very same pixels.
export function sceneFlatShapes(width, height) {
  return rgb(width, height, (u, v) => {
    let c = 0;
    if (u > 0.1 && u < 0.45 && v > 0.15 && v < 0.6) c = 1;
    if ((u - 0.7) ** 2 + ((v - 0.35) * (height / width)) ** 2 < 0.03) c = 2;
    if (v > 0.65 && u + v * 0.5 > 0.9 && u < 0.8) c = 3;
    if (u > 0.05 && u < 0.35 && v > 0.7 && v < 0.9) c = 4;
    if (Math.abs(u - 0.5) < 0.02 && v < 0.5) c = 5;
    if (u > 0.82 && v > 0.62 && v - 0.62 < (u - 0.82) * 2) c = 6;
    if (v < 0.08) c = 7;
    return PALETTE[c];
  });
}

// One channel, only 0 and 255: a Floyd-Steinberg error-diffusion dither of a
// radial gradient with a bar pattern. Large enough to be shrunk before
// hashing, which is where the choice of shrinking filter shows.
export function sceneBilevel(width, height) {
  const level = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      const du = u - 0.5;
      // Mostly large black and white areas, with ramps where the dither shows.
      let l = u * 0.9 + 0.05;
      if ((u - 0.25) ** 2 + ((v - 0.3) * (height / width)) ** 2 < 0.02) l = 1;
      if ((u - 0.7) ** 2 + ((v - 0.35) * (height / width)) ** 2 < 0.03) l = 0;
      if (v > 0.65 && v < 0.9) l = 0.5;
      if (v >= 0.9) l = 0;
      if (du > 0.2 && v > 0.6 && v <= 0.65) l = 1;
      level[y * width + x] = l * 255;
    }
  }
  const px = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const old = level[i];
      const out = old >= 128 ? 255 : 0;
      px[i] = out;
      const err = old - out;
      if (x + 1 < width) level[i + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) level[i + width - 1] += (err * 3) / 16;
        level[i + width] += (err * 5) / 16;
        if (x + 1 < width) level[i + width + 1] += err / 16;
      }
    }
  }
  return px;
}

export function sceneFlat(width, height, colour) {
  return rgb(width, height, () => colour);
}

// A horizontal ramp with a vertical sinusoid of the given amplitude: the
// hash's quality metric counts gradients, so amplitude moves it from 0 to 100.
export function sceneContrast(width, height, amplitude) {
  return rgb(width, height, (u, v) => {
    const wave = Math.sin(v * Math.PI * 14) * amplitude;
    const ramp = (u - 0.5) * amplitude;
    return [128 + wave + ramp, 128 + wave - ramp, 128 - wave];
  });
}

// What the adapter's own tests upload: two unrelated 64 x 64 pictures.
export function sceneAdapterClean() {
  return rgb(64, 64, (u, v, x, y) => [(x * 4) & 255, (y * 4) & 255, ((x + y) * 2) & 255]);
}

export function sceneAdapterBad() {
  return rgb(64, 64, (u, v, x, y) => {
    const c = (Math.floor(x / 8) + Math.floor(y / 8)) % 2;
    return c ? [230, 40, 40] : [20, 20, 120 + (x ^ y)];
  });
}

// The contrast levels. The reference reports quality 0, 24, 49, 54, 77, 82
// and 100 for them: either side of its 49 (discard) and 80 (tolerance) marks.
export const CONTRAST_AMPLITUDES = [4, 8, 12, 13, 17, 18, 22];

// Every picture: file name, how to encode it, and how to get its pixels.
// `lossless` pictures decode to exactly `pixels`, so the reference core can be
// run over the same array; the others are given to its photo hasher as files.
export function pictures() {
  const list = [];
  const add = (spec) => list.push(spec);

  const photoLike = sceneGradientShapes(480, 360);
  const photoLikePng = sceneGradientShapes(256, 192);
  add({
    file: 'scene-a-256x192.png',
    width: 256,
    height: 192,
    channels: 3,
    pixels: photoLikePng,
    encode: (img) => img.png({ compressionLevel: 9 }),
    lossless: true,
    note: 'gradients, disc, rectangle, band and seeded noise',
  });
  add({
    file: 'scene-a-480x360.jpg',
    width: 480,
    height: 360,
    channels: 3,
    pixels: photoLike,
    encode: (img) => img.jpeg({ quality: 90, mozjpeg: false }),
    lossless: false,
    note: 'the same picture as a JPEG at quality 90',
  });
  add({
    file: 'scene-a-small-240x180.jpg',
    width: 240,
    height: 180,
    channels: 3,
    pixels: photoLike,
    sourceWidth: 480,
    sourceHeight: 360,
    encode: (img) => img.resize(240, 180, { kernel: 'lanczos3' }).jpeg({ quality: 50 }),
    lossless: false,
    note: 'a resized and recompressed copy of scene-a (half size, JPEG quality 50)',
  });
  const large = sceneGradientShapes(1280, 960);
  add({
    file: 'scene-a-large-1280x960.jpg',
    width: 1280,
    height: 960,
    channels: 3,
    pixels: large,
    encode: (img) => img.jpeg({ quality: 85, mozjpeg: false }),
    lossless: false,
    note: 'over 512 pixels, so it is shrunk before hashing',
  });
  add({
    file: 'scene-b-256x192.png',
    width: 256,
    height: 192,
    channels: 3,
    pixels: sceneRingsStripes(256, 192),
    encode: (img) => img.png({ compressionLevel: 9 }),
    lossless: true,
    note: 'unrelated to scene-a',
  });
  const flatShapes = sceneFlatShapes(256, 192);
  add({
    file: 'scene-c-256x192.gif',
    width: 256,
    height: 192,
    channels: 3,
    pixels: flatShapes,
    encode: (img) => img.gif({ colours: 256, dither: 0 }),
    lossless: true,
    note: 'eight flat colours, as a GIF',
  });
  add({
    file: 'scene-c-256x192.webp',
    width: 256,
    height: 192,
    channels: 3,
    pixels: flatShapes,
    encode: (img) => img.webp({ lossless: true }),
    lossless: true,
    note: 'the same eight-colour picture as lossless WebP',
  });
  add({
    file: 'bilevel-1600x1000.png',
    width: 1600,
    height: 1000,
    channels: 1,
    pixels: sceneBilevel(1600, 1000),
    encode: (img) => img.png({ palette: true, colours: 2, compressionLevel: 9 }),
    lossless: true,
    note: 'one bit per pixel; shrunk before hashing',
  });
  add({
    file: 'flat-64x64.png',
    width: 64,
    height: 64,
    channels: 3,
    pixels: sceneFlat(64, 64, [180, 90, 40]),
    encode: (img) => img.png({ compressionLevel: 9 }),
    lossless: true,
    note: 'a single colour: quality 0',
  });
  for (const amplitude of CONTRAST_AMPLITUDES) {
    add({
      file: `contrast-${String(amplitude).padStart(2, '0')}-128x128.png`,
      width: 128,
      height: 128,
      channels: 3,
      pixels: sceneContrast(128, 128, amplitude),
      encode: (img) => img.png({ compressionLevel: 9 }),
      lossless: true,
      note: `contrast amplitude ${amplitude}`,
    });
  }
  return list;
}

export function adapterPictures() {
  const make = (file, pixels) => ({
    file,
    width: 64,
    height: 64,
    channels: 3,
    pixels,
    encode: (img) => img.png({ compressionLevel: 9 }),
    lossless: true,
  });
  return [make('clean.png', sceneAdapterClean()), make('bad.png', sceneAdapterBad())];
}

export async function encodeFile(spec) {
  const width = spec.sourceWidth ?? spec.width;
  const height = spec.sourceHeight ?? spec.height;
  const raw = { raw: { width, height, channels: spec.channels } };
  const base = sharp(spec.pixels, raw);
  return spec.encode(spec.channels === 1 ? base.toColourspace('b-w') : base).toBuffer();
}

async function main() {
  const verify = process.argv.includes('--verify');
  const outputs = [
    ...pictures().map((spec) => ({ spec, dir: HERE })),
    ...adapterPictures().map((spec) => ({ spec, dir: path.join(HERE, '..') })),
  ];
  let bad = 0;
  for (const { spec, dir } of outputs) {
    const target = path.join(dir, spec.file);
    if (verify) {
      if (!spec.lossless) continue;
      const { data, info } = await sharp(fs.readFileSync(target))
        .removeAlpha()
        .toColourspace(spec.channels === 1 ? 'b-w' : 'srgb')
        .raw({ depth: 'uchar' })
        .toBuffer({ resolveWithObject: true });
      const same =
        info.width === spec.width &&
        info.height === spec.height &&
        info.channels === spec.channels &&
        data.equals(spec.pixels);
      if (!same) bad += 1;
      console.log(same ? 'same ' : 'DIFF ', spec.file);
    } else {
      fs.writeFileSync(target, await encodeFile(spec));
      console.log('wrote', path.relative(HERE, target));
    }
  }
  if (bad) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
