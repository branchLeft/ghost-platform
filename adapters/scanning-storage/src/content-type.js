'use strict';

const STAMPED = Symbol.for('branchleft.scanningStorage.contentTypeStamped');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const ICO_SIGNATURE = Buffer.from([0x00, 0x00, 0x01, 0x00]);
const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const AVIF_BRANDS = new Set(['avif', 'avis']);

function asBuffer(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

function startsWith(buffer, expected) {
  return buffer.length >= expected.length && buffer.subarray(0, expected.length).equals(expected);
}

function latin1At(buffer, offset, length) {
  return buffer.length >= offset + length
    ? buffer.toString('latin1', offset, offset + length)
    : null;
}

// An ICO has no magic word beyond four bytes that a lot of binary data also
// starts with, so the declared image count must be at least one and the
// directory it implies must fit in the file.
function isIco(buffer) {
  if (!startsWith(buffer, ICO_SIGNATURE) || buffer.length < ICO_HEADER_BYTES) {
    return false;
  }
  const count = buffer.readUInt16LE(4);
  return count > 0 && buffer.length >= ICO_HEADER_BYTES + count * ICO_ENTRY_BYTES;
}

// What a raster image is, from its own bytes. A name, a path or a declared
// type is never an input: the bytes were scanned, and a type an uploader
// chose is not something to serve them under. SVG is deliberately absent
// (it can carry script) and so is anything unrecognised: both stay null, and
// the object keeps the bucket's default type.
function sniffImageContentType(input) {
  const buffer = asBuffer(input);
  if (buffer === null) {
    return null;
  }
  if (startsWith(buffer, JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return 'image/png';
  }
  const head = latin1At(buffer, 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') {
    return 'image/gif';
  }
  if (latin1At(buffer, 0, 4) === 'RIFF' && latin1At(buffer, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  if (latin1At(buffer, 4, 4) === 'ftyp' && AVIF_BRANDS.has(latin1At(buffer, 8, 4))) {
    return 'image/avif';
  }
  if (isIco(buffer)) {
    return 'image/x-icon';
  }
  return null;
}

function isUnset(value) {
  return value === undefined || value === null || value === '';
}

// A PutObject whose body is a whole buffer and which names no type. Not a
// multipart part (it carries an UploadId and PartNumber), which belongs to a
// create call that already set its own type.
function stampCommand(command) {
  const input = command && command.input;
  if (
    !input ||
    !isUnset(input.ContentType) ||
    !isUnset(input.UploadId) ||
    !isUnset(input.PartNumber)
  ) {
    return;
  }
  if (isUnset(input.Key) || !ArrayBuffer.isView(input.Body)) {
    return;
  }
  const type = sniffImageContentType(input.Body);
  if (type !== null) {
    input.ContentType = type;
  }
}

// Ghost's S3Storage.saveRaw(buffer, targetPath) takes no type and sends none,
// and it is the path of every resized derivative, every held upload on
// promotion and every same-name overwrite, so the bucket stores those as
// application/octet-stream and a browser will not draw them as an image.
// saveRaw cannot be told a type, so the type is put on the request itself:
// the wrapped adapter's S3 client is patched once, here, so every write the
// decorator makes through any route is typed from its own bytes.
//
// Returns true when the stamp is on, false when the wrapped adapter has no S3
// client (the local adapters, whose files are typed by the web server).
function stampImageContentType(wrapped) {
  const client = wrapped && wrapped.client;
  if (!client || typeof client.send !== 'function') {
    return false;
  }
  if (client[STAMPED]) {
    return true;
  }
  const send = client.send;
  client.send = function sendWithImageContentType(command, ...rest) {
    stampCommand(command);
    return send.call(this, command, ...rest);
  };
  client[STAMPED] = true;
  return true;
}

module.exports = { sniffImageContentType, stampImageContentType };
