'use strict';

const crypto = require('node:crypto');
const { pdqFromPixels, MIN_HASHABLE_DIM } = require('./pdq-hash');

// Two different things name an upload here, and they must not be confused.
//
// The content digest (SHA-256, hex) names the exact bytes: the quarantine
// file, its refusal record, its hold sidecar, and the check that a file read
// back is the file that was written. It is filename-safe and two different
// files never share one.
//
// The verdict key (a PDQ perceptual hash, base64) is what the hash source is
// asked about. It is the same for near-identical pictures, which is the
// point, and it is never used to name a file.
function digestBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Bounds on what is decoded. Nothing here is a verdict: bytes over a bound
// get no hash and are therefore never allowed on that basis.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
// The reference shrinks anything with a side over this to a square of this
// size before hashing, ignoring the aspect ratio. It uses nearest neighbour;
// Lanczos is used here because it stayed within the reference's tolerance on
// every image of its own test data, where libvips' nearest did not.
const REFERENCE_SIDE = 512;

// Raster formats the hash is defined for. Vector and document formats are
// not pictures a perceptual hash of pixels can stand for.
const RASTER_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif']);

const REASON = Object.freeze({
  EMPTY: 'empty',
  TOO_LARGE: 'too-large',
  NOT_AN_IMAGE: 'not-an-image',
  TOO_SMALL: 'too-small',
  DECODER_UNAVAILABLE: 'decoder-unavailable',
});

let sharpModule;
let sharpLoadError = null;

// Loaded on first use, never at require time: Ghost carries the decoder in
// its own dependency tree, and a module that threw while Ghost loaded its
// adapters would stop Ghost starting. A missing decoder instead yields no
// hash for every upload, which holds them all, and says so.
function loadDecoder() {
  if (sharpModule || sharpLoadError) {
    return sharpModule || null;
  }
  try {
    // eslint-disable-next-line global-require
    sharpModule = require('sharp');
  } catch (err) {
    sharpLoadError = err;
  }
  return sharpModule || null;
}

function decoderLoadError() {
  loadDecoder();
  return sharpLoadError;
}

function none(reason) {
  return { hash: null, quality: null, reason };
}

// Resolves to {hash, quality, reason}: `hash` is the canonical base64 of the
// 32 PDQ bytes, or null with a `reason` when these bytes have no hash. Never
// rejects.
async function pdqHashOfImage(buffer, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const maxPixels = options.maxPixels ?? MAX_IMAGE_PIXELS;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return none(REASON.EMPTY);
  }
  if (buffer.length > maxBytes) {
    return none(REASON.TOO_LARGE);
  }
  const sharp = loadDecoder();
  if (!sharp) {
    return none(REASON.DECODER_UNAVAILABLE);
  }

  const inputOptions = { limitInputPixels: maxPixels, failOn: 'error', sequentialRead: true };
  try {
    // Header only, so the pixel bound is applied here by hand and a picture
    // over it is told apart from bytes that are not a picture.
    const meta = await sharp(buffer, { ...inputOptions, limitInputPixels: false }).metadata();
    if (!RASTER_FORMATS.has(meta.format)) {
      return none(REASON.NOT_AN_IMAGE);
    }
    if (!meta.width || !meta.height) {
      return none(REASON.NOT_AN_IMAGE);
    }
    if (meta.width * meta.height > maxPixels) {
      return none(REASON.TOO_LARGE);
    }
    if (meta.width < MIN_HASHABLE_DIM || meta.height < MIN_HASHABLE_DIM) {
      return none(REASON.TOO_SMALL);
    }

    // No orientation is applied and transparency is dropped, as the
    // reference's own decoder does: the hash is of the stored pixels.
    let pipeline = sharp(buffer, inputOptions);
    if (meta.width > REFERENCE_SIDE || meta.height > REFERENCE_SIDE) {
      pipeline = pipeline.resize(REFERENCE_SIDE, REFERENCE_SIDE, {
        fit: 'fill',
        kernel: 'lanczos3',
        fastShrinkOnLoad: false,
      });
    }
    const grey = meta.space === 'b-w' || meta.space === 'grey16';
    pipeline = pipeline.removeAlpha().toColourspace(grey ? 'b-w' : 'srgb');
    const { data, info } = await pipeline
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });

    const result = pdqFromPixels(data, info.width, info.height, info.channels);
    if (!result) {
      return none(REASON.TOO_SMALL);
    }
    return { hash: result.hash.toString('base64'), quality: result.quality, reason: null };
  } catch {
    return none(REASON.NOT_AN_IMAGE);
  }
}

module.exports = {
  digestBytes,
  pdqHashOfImage,
  decoderLoadError,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  REFERENCE_SIDE,
  REASON,
};
