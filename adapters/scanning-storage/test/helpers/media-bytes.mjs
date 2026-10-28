// Synthetic, tiny byte fixtures for the media-kind detector and the
// decorator tests. Nothing here is real media: each buffer carries only the
// container structure the detector reads, built in code so no file is
// committed or downloaded. See media-kind.md for what the detector reads.

function ascii(text) {
  return Buffer.from(text, 'latin1');
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

// An ISO base media box: 32-bit size, four-character type, payload.
export function box(type, payload = Buffer.alloc(0)) {
  return Buffer.concat([uint32(8 + payload.length), ascii(type), payload]);
}

function fileTypeBox(majorBrand, compatibleBrands = []) {
  return box(
    'ftyp',
    Buffer.concat([ascii(majorBrand), uint32(0), ...compatibleBrands.map((brand) => ascii(brand))])
  );
}

// A movie box holding one track whose handler reference names `handlerType`.
function movieBox(handlerType) {
  const handlerPayload = Buffer.concat([
    uint32(0),
    uint32(0),
    ascii(handlerType),
    Buffer.alloc(12),
  ]);
  return box('moov', box('trak', box('mdia', box('hdlr', handlerPayload))));
}

const MEDIA_DATA = box('mdat', Buffer.alloc(32, 0x5a));

export function mp4Bytes(majorBrand = 'isom') {
  return Buffer.concat([fileTypeBox(majorBrand, ['isom', 'mp42']), movieBox('vide'), MEDIA_DATA]);
}

export function quickTimeBytes() {
  return mp4Bytes('qt  ');
}

export function m4aBytes() {
  return Buffer.concat([
    fileTypeBox('M4A ', ['M4A ', 'mp42', 'isom']),
    movieBox('soun'),
    MEDIA_DATA,
  ]);
}

export function threeGpBytes() {
  return mp4Bytes('3gp4');
}

// Old QuickTime and some MP4s carry no ftyp: the first box is wide/free/mdat.
export function quickTimeWithoutFileTypeBytes() {
  return Buffer.concat([box('wide'), MEDIA_DATA, movieBox('vide')]);
}

export function moovFirstWithoutFileTypeBytes() {
  return Buffer.concat([movieBox('vide'), MEDIA_DATA]);
}

// A still HEIF-family image: image brand, a meta box, image data, no movie box.
export function stillImageBytes(majorBrand) {
  return Buffer.concat([
    fileTypeBox(majorBrand, ['mif1', 'miaf']),
    box('meta', Buffer.concat([uint32(0), box('hdlr', Buffer.alloc(24))])),
    MEDIA_DATA,
  ]);
}

// An animated image sequence: an image brand with a movie box whose track is
// a picture track, not a video track.
export function imageSequenceBytes(majorBrand = 'avis') {
  return Buffer.concat([fileTypeBox(majorBrand, ['msf1']), movieBox('pict'), MEDIA_DATA]);
}

// A video that claims an image brand.
export function videoWithImageBrandBytes(majorBrand = 'avif') {
  return mp4Bytes(majorBrand);
}

function ebmlBytes(docType) {
  const docTypeElement = Buffer.concat([
    Buffer.from([0x42, 0x82, 0x80 | docType.length]),
    ascii(docType),
  ]);
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | docTypeElement.length]),
    docTypeElement,
    Buffer.alloc(16),
  ]);
}

export function webmBytes() {
  return ebmlBytes('webm');
}

export function matroskaBytes() {
  return ebmlBytes('matroska');
}

export function oggBytes() {
  return Buffer.concat([ascii('OggS'), Buffer.from([0, 2]), Buffer.alloc(40)]);
}

export function flacBytes() {
  return Buffer.concat([ascii('fLaC'), Buffer.from([0x80, 0, 0, 34]), Buffer.alloc(34)]);
}

// MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, no padding: 417-byte frames.
const MP3_FRAME_LENGTH = 417;
const MP3_FRAME_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

export function mp3Bytes(frameCount = 3) {
  const frame = Buffer.alloc(MP3_FRAME_LENGTH);
  MP3_FRAME_HEADER.copy(frame);
  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

function syncSafe(value) {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

// An ID3v2 tag: `bodyLength` bytes of body after the ten-byte header, plus a
// ten-byte footer when `hasFooter` is set.
export function id3Tag(bodyLength, { hasFooter = false } = {}) {
  const header = Buffer.concat([
    ascii('ID3'),
    Buffer.from([4, 0, hasFooter ? 0x10 : 0]),
    syncSafe(bodyLength),
  ]);
  const footer = hasFooter ? Buffer.concat([ascii('3DI'), header.subarray(3)]) : Buffer.alloc(0);
  return Buffer.concat([header, Buffer.alloc(bodyLength, 0x20), footer]);
}

export function mp3WithId3Bytes(options = {}) {
  return Buffer.concat([id3Tag(options.bodyLength ?? 300, options), mp3Bytes(options.frameCount)]);
}

export function id3OnlyBytes() {
  return id3Tag(64);
}

function riffBytes(formType) {
  return Buffer.concat([ascii('RIFF'), Buffer.alloc(4, 0x10), ascii(formType), Buffer.alloc(32)]);
}

export function wavBytes() {
  return riffBytes('WAVE');
}

export function aviBytes() {
  return riffBytes('AVI ');
}

export function webpBytes() {
  return riffBytes('WEBP');
}

export function aiffBytes() {
  return Buffer.concat([ascii('FORM'), Buffer.alloc(4, 0x10), ascii('AIFF'), Buffer.alloc(32)]);
}

export function interchangeBitmapBytes() {
  return Buffer.concat([ascii('FORM'), Buffer.alloc(4, 0x10), ascii('ILBM'), Buffer.alloc(32)]);
}

// AAC in ADTS framing: MPEG-4, no CRC, 44.1 kHz, frames of `frameLength` bytes.
export function adtsBytes(frameCount = 3, frameLength = 100) {
  const frame = Buffer.alloc(frameLength);
  frame[0] = 0xff;
  frame[1] = 0xf1;
  frame[2] = 0x50;
  frame[3] = 0x80 | (frameLength >> 11);
  frame[4] = (frameLength >> 3) & 0xff;
  frame[5] = ((frameLength & 7) << 5) | 0x1f;
  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

export function flvBytes() {
  return Buffer.concat([ascii('FLV'), Buffer.from([1, 5, 0, 0, 0, 9]), Buffer.alloc(16)]);
}

export function asfBytes() {
  return Buffer.concat([Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex'), Buffer.alloc(24)]);
}

export function midiBytes() {
  return Buffer.concat([ascii('MThd'), uint32(6), Buffer.alloc(6)]);
}

export function mpegProgramStreamBytes() {
  return Buffer.concat([Buffer.from([0, 0, 1, 0xba]), Buffer.alloc(32)]);
}

// Transport-stream packets: a 0x47 sync byte every `stride` bytes.
export function transportStreamBytes(packetCount = 5, stride = 188, firstSyncOffset = 0) {
  const stream = Buffer.alloc(firstSyncOffset + packetCount * stride);
  for (let index = 0; index < packetCount; index += 1) {
    stream[firstSyncOffset + index * stride] = 0x47;
  }
  return stream;
}

export function pdfBytes() {
  return ascii('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
}

export function zipBytes() {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 0x11)]);
}

export function textBytes(text = 'Plain text that mentions ftyp, moov and mdat.') {
  return ascii(text);
}

export function pngBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    box('IHDR', Buffer.alloc(13)),
    box('IEND'),
  ]);
}

export function jpegBytes() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
    ascii('JFIF\0'),
    Buffer.alloc(40, 0xff),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function gifBytes() {
  return Buffer.concat([ascii('GIF89a'), Buffer.alloc(40)]);
}

export function bitmapBytes() {
  return Buffer.concat([ascii('BM'), Buffer.alloc(60)]);
}
