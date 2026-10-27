'use strict';

const MEDIA_KIND = Object.freeze({
  VIDEO_OR_AUDIO: 'video-or-audio',
  OTHER: 'other',
});

const ISO_BOX_HEADER_BYTES = 8;
const ISO_LARGE_BOX_HEADER_BYTES = 16;
const ISO_MAX_TOP_LEVEL_BOXES = 64;
const ISO_MAX_HANDLER_SEARCH_STEPS = 256;
const ISO_HANDLER_TYPE_OFFSET = 12;
const ID3_HEADER_BYTES = 10;
const ID3_FOOTER_BYTES = 10;
const ID3_FOOTER_FLAG = 0x10;
const ID3_MAX_TAGS = 8;
const TRANSPORT_PACKET_COUNT = 4;

// Still-picture and picture-sequence brands of HEIF-family images. A file
// with one of these is an image unless its movie box carries a video or
// sound track.
const IMAGE_BRANDS = new Set([
  'avif',
  'avis',
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'mif2',
  'msf1',
  'miaf',
  'MA1A',
  'MA1B',
]);
// Boxes an ISO or QuickTime file may start with when it has no ftyp.
const LEADING_BOX_TYPES = new Set(['moov', 'mdat', 'free', 'wide', 'skip', 'pnot']);
const MEDIA_HANDLER_TYPES = new Set(['vide', 'soun']);

// Containers every one of whose files is video or audio, matched on the
// leading bytes alone.
const PREFIX_SIGNATURES = [
  { family: 'matroska', bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]) },
  { family: 'ogg', bytes: Buffer.from('OggS', 'latin1') },
  { family: 'flac', bytes: Buffer.from('fLaC', 'latin1') },
  { family: 'flv', bytes: Buffer.from('FLV\x01', 'latin1') },
  { family: 'asf', bytes: Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex') },
  { family: 'midi', bytes: Buffer.from('MThd\0\0\0\x06', 'latin1') },
  { family: 'amr', bytes: Buffer.from('#!AMR\n', 'latin1') },
  { family: 'amr', bytes: Buffer.from('#!AMR-WB\n', 'latin1') },
  { family: 'caf', bytes: Buffer.from('caff\0\x01', 'latin1') },
  { family: 'wavpack', bytes: Buffer.from('wvpk', 'latin1') },
  { family: 'mpeg-program-stream', bytes: Buffer.from([0x00, 0x00, 0x01, 0xba]) },
  { family: 'mpeg-video', bytes: Buffer.from([0x00, 0x00, 0x01, 0xb3]) },
];

const RIFF_FORM_FAMILIES = new Map([
  ['WAVE', 'riff-wave'],
  ['AVI ', 'riff-avi'],
  ['RMID', 'midi'],
]);
const IFF_AUDIO_FORMS = new Set(['AIFF', 'AIFC', '8SVX']);

// Bitrates in kbit/s by [version family][layer], indexed by the header's
// four-bit bitrate field; index 0 is free format and 15 is invalid, and both
// are left out because a frame length cannot be derived for either.
const BITRATES_KBPS = {
  mpeg1: {
    1: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  mpeg2: {
    1: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
// By the header's two-bit version field: 3 is MPEG-1, 2 is MPEG-2, 0 is
// MPEG-2.5; 1 is reserved.
const MPEG_VERSIONS = {
  3: { family: 'mpeg1', sampleRates: [44100, 48000, 32000] },
  2: { family: 'mpeg2', sampleRates: [22050, 24000, 16000] },
  0: { family: 'mpeg2', sampleRates: [11025, 12000, 8000] },
};
// By the header's two-bit layer field: 3 is Layer I, 2 is II, 1 is III.
const MPEG_LAYERS = { 3: 1, 2: 2, 1: 3 };

const ADTS_MAX_SAMPLING_FREQUENCY_INDEX = 12;
const ADTS_MIN_FRAME_BYTES = 7;

function asBuffer(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

function hasBytes(buffer, offset, expected) {
  if (offset < 0 || offset + expected.length > buffer.length) {
    return false;
  }
  return buffer.subarray(offset, offset + expected.length).equals(expected);
}

function latin1At(buffer, offset, length) {
  if (offset < 0 || offset + length > buffer.length) {
    return null;
  }
  return buffer.toString('latin1', offset, offset + length);
}

function detectPrefixFamily(buffer, offset) {
  const match = PREFIX_SIGNATURES.find((signature) => hasBytes(buffer, offset, signature.bytes));
  return match ? match.family : null;
}

function detectRiff(buffer) {
  if (latin1At(buffer, 0, 4) !== 'RIFF') {
    return null;
  }
  return RIFF_FORM_FAMILIES.get(latin1At(buffer, 8, 4)) ?? null;
}

function detectIff(buffer) {
  if (latin1At(buffer, 0, 4) !== 'FORM') {
    return null;
  }
  return IFF_AUDIO_FORMS.has(latin1At(buffer, 8, 4)) ? 'iff-audio' : null;
}

function isPrintableBoxType(type) {
  return /^[\x20-\x7e\xa9]{4}$/.test(type);
}

// One ISO base media box at `offset`, or null when no plausible box starts
// there. A box that declares more bytes than the buffer holds is returned,
// clamped to the buffer and marked truncated.
function readIsoBox(buffer, offset) {
  const type = latin1At(buffer, offset + 4, 4);
  if (type === null || !isPrintableBoxType(type)) {
    return null;
  }
  const declaredSize = buffer.readUInt32BE(offset);
  let headerBytes = ISO_BOX_HEADER_BYTES;
  let size = declaredSize;
  if (declaredSize === 1) {
    if (offset + ISO_LARGE_BOX_HEADER_BYTES > buffer.length) {
      return null;
    }
    headerBytes = ISO_LARGE_BOX_HEADER_BYTES;
    size = Number(buffer.readBigUInt64BE(offset + ISO_BOX_HEADER_BYTES));
  } else if (declaredSize === 0) {
    size = buffer.length - offset;
  }
  if (!Number.isSafeInteger(size) || size < headerBytes) {
    return null;
  }
  const end = Math.min(offset + size, buffer.length);
  return { type, start: offset, end, headerBytes, truncated: offset + size > buffer.length };
}

function readTopLevelIsoBoxes(buffer) {
  const boxes = [];
  let offset = 0;
  while (boxes.length < ISO_MAX_TOP_LEVEL_BOXES && offset + ISO_BOX_HEADER_BYTES <= buffer.length) {
    const box = readIsoBox(buffer, offset);
    if (box === null) {
      break;
    }
    boxes.push(box);
    if (box.truncated) {
      break;
    }
    offset = box.end;
  }
  return boxes;
}

// True when the movie box holds a track whose handler is video or sound. Out
// of search steps without a decision it returns true, so an undecided file is
// refused rather than passed as an image.
function hasVideoOrSoundTrack(buffer, movieBox) {
  const payloadStart = movieBox.start + movieBox.headerBytes;
  let from = payloadStart;
  for (let step = 0; step < ISO_MAX_HANDLER_SEARCH_STEPS; step += 1) {
    const found = buffer.indexOf('hdlr', from, 'latin1');
    if (found < 0 || found >= movieBox.end) {
      return false;
    }
    const handler = latin1At(buffer, found + ISO_HANDLER_TYPE_OFFSET, 4);
    if (handler !== null && MEDIA_HANDLER_TYPES.has(handler)) {
      return true;
    }
    from = found + 4;
  }
  return true;
}

function isVideoOrAudioWithFileType(buffer, boxes) {
  const brand = latin1At(buffer, ISO_BOX_HEADER_BYTES, 4);
  if (brand === null || !IMAGE_BRANDS.has(brand)) {
    return true;
  }
  // An image brand is the claim of the file, not a fact about its tracks. A
  // top-level walk that stopped at its box limit before any movie box leaves
  // the file undecided, so it is refused rather than passed as an image.
  const movieBox = boxes.find((box) => box.type === 'moov');
  if (movieBox === undefined) {
    return boxes.length >= ISO_MAX_TOP_LEVEL_BOXES;
  }
  return hasVideoOrSoundTrack(buffer, movieBox);
}

function detectIsoBaseMedia(buffer) {
  const boxes = readTopLevelIsoBoxes(buffer);
  const first = boxes[0];
  if (first === undefined || first.truncated) {
    return null;
  }
  if (first.type === 'ftyp') {
    return isVideoOrAudioWithFileType(buffer, boxes) ? 'iso-base-media' : null;
  }
  const hasMediaBox = boxes.some((box) => box.type === 'moov' || box.type === 'mdat');
  return LEADING_BOX_TYPES.has(first.type) && hasMediaBox ? 'iso-base-media' : null;
}

// Total length of the ID3v2 tag at `offset`, or 0 when none starts there.
function readId3TagBytes(buffer, offset) {
  if (latin1At(buffer, offset, 3) !== 'ID3' || offset + ID3_HEADER_BYTES > buffer.length) {
    return 0;
  }
  const [major, revision, flags, ...sizeBytes] = buffer.subarray(
    offset + 3,
    offset + ID3_HEADER_BYTES
  );
  if (major === 0xff || revision === 0xff || sizeBytes.some((byte) => byte >= 0x80)) {
    return 0;
  }
  const bodyBytes = sizeBytes.reduce((total, byte) => total * 128 + byte, 0);
  const footerBytes = flags & ID3_FOOTER_FLAG ? ID3_FOOTER_BYTES : 0;
  return ID3_HEADER_BYTES + bodyBytes + footerBytes;
}

// The offset of the first byte after any leading ID3v2 tags; 0 when the
// buffer does not start with one.
function skipId3Tags(buffer) {
  let offset = 0;
  for (let tags = 0; tags < ID3_MAX_TAGS; tags += 1) {
    const tagBytes = readId3TagBytes(buffer, offset);
    if (tagBytes === 0) {
      break;
    }
    offset += tagBytes;
  }
  return offset;
}

function parseMpegAudioHeader(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) {
    return null;
  }
  const [, second, third] = buffer.subarray(offset, offset + 4);
  if (buffer[offset] !== 0xff || (second & 0xe0) !== 0xe0) {
    return null;
  }
  const version = MPEG_VERSIONS[(second >> 3) & 3];
  const layer = MPEG_LAYERS[(second >> 1) & 3];
  const bitrateKbps =
    version && layer ? BITRATES_KBPS[version.family][layer][(third >> 4) - 1] : undefined;
  const sampleRate = version?.sampleRates[(third >> 2) & 3];
  if (bitrateKbps === undefined || sampleRate === undefined) {
    return null;
  }
  const padding = (third >> 1) & 1;
  const bitsPerSample = layer === 3 && version.family === 'mpeg2' ? 72 : 144;
  const frameBytes =
    layer === 1
      ? (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + padding) * 4
      : Math.floor((bitsPerSample * bitrateKbps * 1000) / sampleRate) + padding;
  return { versionKey: (second >> 3) & 3, layer, sampleRate, frameBytes };
}

function isSameMpegStream(first, second) {
  return (
    second !== null &&
    second.versionKey === first.versionKey &&
    second.layer === first.layer &&
    second.sampleRate === first.sampleRate
  );
}

// A header at `offset` counts only when the next frame follows where it says
// it will, or the buffer ends inside this frame, so a stray byte pair cannot
// pass as audio.
function detectMpegAudio(buffer, offset) {
  const header = parseMpegAudioHeader(buffer, offset);
  if (header === null) {
    return null;
  }
  const nextOffset = offset + header.frameBytes;
  if (
    nextOffset >= buffer.length ||
    isSameMpegStream(header, parseMpegAudioHeader(buffer, nextOffset))
  ) {
    return 'mpeg-audio';
  }
  return null;
}

function parseAdtsFrameBytes(buffer, offset) {
  if (offset < 0 || offset + 6 > buffer.length) {
    return 0;
  }
  const [first, second, third, fourth, fifth, sixth] = buffer.subarray(offset, offset + 6);
  if (first !== 0xff || (second & 0xf6) !== 0xf0) {
    return 0;
  }
  if (((third >> 2) & 0x0f) > ADTS_MAX_SAMPLING_FREQUENCY_INDEX) {
    return 0;
  }
  const frameBytes = ((fourth & 3) << 11) | (fifth << 3) | (sixth >> 5);
  return frameBytes >= ADTS_MIN_FRAME_BYTES ? frameBytes : 0;
}

function detectAdts(buffer, offset) {
  const frameBytes = parseAdtsFrameBytes(buffer, offset);
  if (frameBytes === 0) {
    return null;
  }
  const nextOffset = offset + frameBytes;
  return nextOffset >= buffer.length || parseAdtsFrameBytes(buffer, nextOffset) > 0 ? 'adts' : null;
}

function hasTransportSyncBytes(buffer, firstSyncOffset, strideBytes) {
  for (let packet = 0; packet < TRANSPORT_PACKET_COUNT; packet += 1) {
    if (buffer[firstSyncOffset + packet * strideBytes] !== 0x47) {
      return false;
    }
  }
  return true;
}

// 188-byte packets, or 192-byte packets with a four-byte timestamp in front.
function detectTransportStream(buffer) {
  if (hasTransportSyncBytes(buffer, 0, 188) || hasTransportSyncBytes(buffer, 4, 192)) {
    return 'mpeg-transport-stream';
  }
  return null;
}

function firstFamily(detectors) {
  for (const detect of detectors) {
    const family = detect();
    if (family !== null) {
      return family;
    }
  }
  return null;
}

// The container family when the bytes are video or audio, else null. Decided
// from the bytes alone, never from a name or a declared type.
function detectVideoAudioFamily(input) {
  const buffer = asBuffer(input);
  if (buffer === null) {
    return null;
  }
  const audioStart = skipId3Tags(buffer);
  const detectors = [
    () => detectPrefixFamily(buffer, audioStart),
    () => detectMpegAudio(buffer, audioStart),
    () => detectAdts(buffer, audioStart),
  ];
  if (audioStart === 0) {
    detectors.push(
      () => detectRiff(buffer),
      () => detectIff(buffer),
      () => detectIsoBaseMedia(buffer),
      () => detectTransportStream(buffer)
    );
  }
  return firstFamily(detectors);
}

function classifyMediaKind(input) {
  return detectVideoAudioFamily(input) === null ? MEDIA_KIND.OTHER : MEDIA_KIND.VIDEO_OR_AUDIO;
}

module.exports = { MEDIA_KIND, classifyMediaKind, detectVideoAudioFamily };
