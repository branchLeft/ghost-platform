// Deterministic pictures for the perceptual hash tests, built in code with the
// same decoder the adapter uses, so no image file is committed or downloaded.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp') as typeof import('sharp').default;

// A small seeded generator, so a picture is the same on every run and machine.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// A picture of soft blobs of colour on a gradient: low-frequency structure a
// perceptual hash can hold on to, unlike flat colour or white noise. Two
// different seeds give two unrelated pictures.
export async function texturedPng(seed: number, side = 256): Promise<Buffer> {
  const next = seeded(seed);
  const blobs = Array.from({ length: 9 }, () => ({
    x: next() * side,
    y: next() * side,
    radius: side * (0.12 + next() * 0.25),
    colour: [next() * 255, next() * 255, next() * 255] as const,
  }));
  const pixels = Buffer.alloc(side * side * 3);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const out = (y * side + x) * 3;
      const base = ((x + y) / (2 * side)) * 96;
      let r = base;
      let g = base;
      let b = base;
      for (const blob of blobs) {
        const distance = Math.hypot(x - blob.x, y - blob.y);
        const weight = Math.max(0, 1 - distance / blob.radius);
        r += weight * blob.colour[0];
        g += weight * blob.colour[1];
        b += weight * blob.colour[2];
      }
      pixels[out] = Math.min(255, r);
      pixels[out + 1] = Math.min(255, g);
      pixels[out + 2] = Math.min(255, b);
    }
  }
  return sharp(pixels, { raw: { width: side, height: side, channels: 3 } })
    .png()
    .toBuffer();
}

// The same picture as another size, and as another format: what a re-upload of
// a resized or recompressed copy looks like.
export async function resizedPng(picture: Buffer, side: number): Promise<Buffer> {
  return sharp(picture).resize(side, side, { fit: 'fill' }).png().toBuffer();
}

export async function asJpeg(picture: Buffer, quality = 80): Promise<Buffer> {
  return sharp(picture).jpeg({ quality }).toBuffer();
}
