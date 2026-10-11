'use strict';

// A JavaScript port of the PDQ perceptual hash's pixel-to-hash stage.
//
// Derived from the reference implementation in facebook/ThreatExchange
// (directory pdq/, C++ files hashing/pdqhashing.cpp, hashing/torben.cpp and
// downscaling/downscaling.cpp).
//
// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// BSD licence, reproduced in THIRD-PARTY-LICENSE-ThreatExchange-PDQ.txt next
// to this file, with the commit this was ported from.

const HASH_BYTES = 32;
// The reference refuses to hash anything with a side shorter than this.
const MIN_HASHABLE_DIM = 5;
const HASH_SIDE = 64;
const DCT_SIDE = 16;
// Two X-then-Y passes of a box filter make the tent filter the reference uses.
const JAROSZ_PASSES = 2;

const fround = Math.fround;

// Single precision on purpose: the reference works in `float`, and a hash
// bit can sit within one rounding step of the median, so every arithmetic
// step below is rounded to float32 exactly where the C++ rounds it.
const LUMA_R = fround(0.299);
const LUMA_G = fround(0.587);
const LUMA_B = fround(0.114);

// 16 x 64 matrix of the first 16 non-DC DCT-II basis rows, as the reference
// builds it: scale in float, cosine in double, stored as float.
const DCT_MATRIX = (() => {
  const scale = fround(Math.sqrt(2.0 / HASH_SIDE));
  const matrix = new Float32Array(DCT_SIDE * HASH_SIDE);
  for (let i = 0; i < DCT_SIDE; i += 1) {
    for (let j = 0; j < HASH_SIDE; j += 1) {
      matrix[i * HASH_SIDE + j] =
        scale * Math.cos((Math.PI / 2.0 / HASH_SIDE) * (i + 1) * (2 * j + 1));
    }
  }
  return matrix;
})();

function lumaFromRgb(pixels, rows, cols) {
  const luma = new Float32Array(rows * cols);
  for (let i = 0, p = 0; i < luma.length; i += 1, p += 3) {
    const r = fround(LUMA_R * pixels[p]);
    const g = fround(LUMA_G * pixels[p + 1]);
    const b = fround(LUMA_B * pixels[p + 2]);
    luma[i] = fround(fround(r + g) + b);
  }
  return luma;
}

function lumaFromGrey(pixels, rows, cols) {
  const luma = new Float32Array(rows * cols);
  for (let i = 0; i < luma.length; i += 1) {
    luma[i] = pixels[i];
  }
  return luma;
}

// One 1-D box filter, written as the reference's four phases so the running
// sum accumulates in the same order and rounds the same way.
function box1D(input, inStart, output, outStart, length, stride, fullWindow) {
  const half = Math.floor((fullWindow + 2) / 2);
  const phase1 = half - 1;
  const phase2 = fullWindow - half + 1;
  const phase3 = length - fullWindow;
  const phase4 = half - 1;
  let li = inStart;
  let ri = inStart;
  let oi = outStart;
  let sum = 0;
  let size = 0;

  for (let i = 0; i < phase1; i += 1) {
    sum = fround(sum + input[ri]);
    size += 1;
    ri += stride;
  }
  for (let i = 0; i < phase2; i += 1) {
    sum = fround(sum + input[ri]);
    size += 1;
    output[oi] = fround(sum / size);
    ri += stride;
    oi += stride;
  }
  for (let i = 0; i < phase3; i += 1) {
    sum = fround(sum + input[ri]);
    sum = fround(sum - input[li]);
    output[oi] = fround(sum / size);
    li += stride;
    ri += stride;
    oi += stride;
  }
  for (let i = 0; i < phase4; i += 1) {
    sum = fround(sum - input[li]);
    size -= 1;
    output[oi] = fround(sum / size);
    li += stride;
    oi += stride;
  }
}

function boxAlongRows(input, output, rows, cols, window) {
  for (let i = 0; i < rows; i += 1) {
    box1D(input, i * cols, output, i * cols, cols, 1, window);
  }
}

function boxAlongCols(input, output, rows, cols, window) {
  for (let j = 0; j < cols; j += 1) {
    box1D(input, j, output, j, rows, cols, window);
  }
}

function jaroszWindow(oldDimension) {
  return Math.floor((oldDimension + 2 * HASH_SIDE - 1) / (2 * HASH_SIDE));
}

// Blur `luma` in place (using one scratch buffer), then take 64 x 64 samples
// at the centres of the 64 x 64 cells.
function downscaleTo64(luma, rows, cols) {
  const scratch = new Float32Array(luma.length);
  const alongRows = jaroszWindow(cols);
  const alongCols = jaroszWindow(rows);
  for (let pass = 0; pass < JAROSZ_PASSES; pass += 1) {
    boxAlongRows(luma, scratch, rows, cols, alongRows);
    boxAlongCols(scratch, luma, rows, cols, alongCols);
  }
  const out = new Float32Array(HASH_SIDE * HASH_SIDE);
  for (let oi = 0; oi < HASH_SIDE; oi += 1) {
    const ini = Math.floor(((oi + 0.5) * rows) / HASH_SIDE);
    for (let oj = 0; oj < HASH_SIDE; oj += 1) {
      const inj = Math.floor(((oj + 0.5) * cols) / HASH_SIDE);
      out[oi * HASH_SIDE + oj] = luma[ini * cols + inj];
    }
  }
  return out;
}

// Counts gradients that are large enough to matter, as the reference does.
function qualityOf(buffer) {
  let sum = 0;
  const gradient = (u, v) => Math.abs(Math.trunc(fround(fround(fround(u - v) * 100) / 255)));
  for (let i = 0; i < HASH_SIDE - 1; i += 1) {
    for (let j = 0; j < HASH_SIDE; j += 1) {
      sum += gradient(buffer[i * HASH_SIDE + j], buffer[(i + 1) * HASH_SIDE + j]);
    }
  }
  for (let i = 0; i < HASH_SIDE; i += 1) {
    for (let j = 0; j < HASH_SIDE - 1; j += 1) {
      sum += gradient(buffer[i * HASH_SIDE + j], buffer[i * HASH_SIDE + j + 1]);
    }
  }
  return Math.min(100, Math.trunc(sum / 90));
}

// B = D A Dt for the 16 x 16 low-frequency corner only.
function dct64To16(buffer) {
  const D = DCT_MATRIX;
  const T = new Float32Array(DCT_SIDE * HASH_SIDE);
  for (let i = 0; i < DCT_SIDE; i += 1) {
    for (let j = 0; j < HASH_SIDE; j += 1) {
      let sum = 0;
      for (let k = 0; k < HASH_SIDE; k += 1) {
        sum = fround(sum + fround(D[i * HASH_SIDE + k] * buffer[k * HASH_SIDE + j]));
      }
      T[i * HASH_SIDE + j] = sum;
    }
  }
  const B = new Float32Array(DCT_SIDE * DCT_SIDE);
  for (let i = 0; i < DCT_SIDE; i += 1) {
    for (let j = 0; j < DCT_SIDE; j += 1) {
      let sum = 0;
      for (let k = 0; k < HASH_SIDE; k += 1) {
        sum = fround(sum + fround(T[i * HASH_SIDE + k] * D[j * HASH_SIDE + k]));
      }
      B[i * DCT_SIDE + j] = sum;
    }
  }
  return B;
}

// Torben Mogensen's median-without-sorting (public domain, as the
// reference's own header says); the same loop and tie handling.
function torben(values) {
  const n = values.length;
  const half = Math.floor((n + 1) / 2);
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < n; i += 1) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  for (;;) {
    const guess = fround(fround(min + max) / 2);
    let less = 0;
    let greater = 0;
    let equal = 0;
    let maxLessThanGuess = min;
    let minGreaterThanGuess = max;
    for (let i = 0; i < n; i += 1) {
      const v = values[i];
      if (v < guess) {
        less += 1;
        if (v > maxLessThanGuess) maxLessThanGuess = v;
      } else if (v > guess) {
        greater += 1;
        if (v < minGreaterThanGuess) minGreaterThanGuess = v;
      } else {
        equal += 1;
      }
    }
    if (less <= half && greater <= half) {
      if (less >= half) return maxLessThanGuess;
      if (less + equal >= half) return guess;
      return minGreaterThanGuess;
    }
    if (less > greater) {
      max = maxLessThanGuess;
    } else {
      min = minGreaterThanGuess;
    }
  }
}

// Bit k (row-major over the 16 x 16 block) is word k >> 4, bit k & 15. The
// 32 bytes are the reference's canonical hex text decoded: word 15 first,
// each word high byte first.
function bitsToBytes(block) {
  const median = torben(block);
  const words = new Uint16Array(16);
  for (let k = 0; k < DCT_SIDE * DCT_SIDE; k += 1) {
    if (block[k] > median) {
      words[k >> 4] |= 1 << (k & 15);
    }
  }
  const bytes = Buffer.alloc(HASH_BYTES);
  for (let w = 0; w < 16; w += 1) {
    bytes[2 * (15 - w)] = words[w] >> 8;
    bytes[2 * (15 - w) + 1] = words[w] & 0xff;
  }
  return bytes;
}

// `channels` is 3 (R, G, B bytes per pixel) or 1 (grey). Returns null for a
// side shorter than the reference's minimum, never a zero hash: a zero hash
// would be the same key for every tiny image.
function pdqFromPixels(pixels, width, height, channels) {
  if (channels !== 1 && channels !== 3) {
    throw new RangeError('pdqFromPixels: channels must be 1 or 3');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('pdqFromPixels: width and height must be positive integers');
  }
  if (pixels.length < width * height * channels) {
    throw new RangeError('pdqFromPixels: pixel buffer is shorter than width * height * channels');
  }
  if (width < MIN_HASHABLE_DIM || height < MIN_HASHABLE_DIM) {
    return null;
  }
  const luma =
    channels === 3 ? lumaFromRgb(pixels, height, width) : lumaFromGrey(pixels, height, width);
  // An image already 64 x 64 skips the blur, as the reference does.
  const small =
    width === HASH_SIDE && height === HASH_SIDE ? luma : downscaleTo64(luma, height, width);
  const quality = qualityOf(small);
  const hash = bitsToBytes(dct64To16(small));
  return { hash, quality };
}

module.exports = { pdqFromPixels, HASH_BYTES, MIN_HASHABLE_DIM };
