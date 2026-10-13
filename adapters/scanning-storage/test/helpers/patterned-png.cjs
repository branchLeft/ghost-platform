'use strict';

const zlib = require('node:zlib');
const { pdqFromPixels } = require('../../src/pdq-hash.js');

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
}

function encodePng(pixels, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]), pixels.subarray(y * width * 3, (y + 1) * width * 3));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A valid RGB PNG of random colour blocks, and the perceptual hash a decoder
// that reproduces its pixels exactly will compute for it. Different seeds
// give unrelated pictures, so a test can hold, refuse or upload bytes no
// other scenario uses. `block` is the side of a colour block in pixels.
function patternedPng(seed, { width = 64, height = 64, block = 8 } = {}) {
  const next = lcg(seed);
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const colours = Array.from({ length: cols * rows }, () => [next(), next(), next()]);
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = colours[Math.floor(y / block) * cols + Math.floor(x / block)];
      pixels.set(c, (y * width + x) * 3);
    }
  }
  const hashed = pdqFromPixels(pixels, width, height, 3);
  return {
    png: encodePng(pixels, width, height),
    key: hashed ? hashed.hash.toString('base64') : null,
  };
}

module.exports = { patternedPng };
