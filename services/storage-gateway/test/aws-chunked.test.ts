import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  STREAMING_UNSIGNED_TRAILER,
  createUnsignedTrailerDecoder,
  parseStreamingTrailer,
  type ChecksumHeader,
  type StreamingTrailer,
} from '../src/aws-chunked.js';

/** The value of CRC-32C over "123456789", a published check value. */
const CRC32C_CHECK = Buffer.from([0xe3, 0x06, 0x92, 0x83]).toString('base64');
/** The value of CRC-32 over "123456789", a published check value. */
const CRC32_CHECK = Buffer.from([0xcb, 0xf4, 0x39, 0x26]).toString('base64');

const encode = (payload: Buffer, checksumName: string, checksum: string, chunk = 4): Buffer => {
  const parts: Buffer[] = [];
  for (let at = 0; at < payload.length; at += chunk) {
    const piece = payload.subarray(at, at + chunk);
    parts.push(Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`0\r\n${checksumName}:${checksum}\r\n\r\n`));
  return Buffer.concat(parts);
};

async function decode(
  wire: Buffer,
  expected: StreamingTrailer,
  slice = wire.length
): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for (let at = 0; at < wire.length; at += slice) pieces.push(wire.subarray(at, at + slice));
  const out: Buffer[] = [];
  const decoder = Readable.from(pieces, { objectMode: false }).pipe(
    createUnsignedTrailerDecoder(expected)
  );
  for await (const chunk of decoder) out.push(chunk as Buffer);
  return Buffer.concat(out);
}

const nine = Buffer.from('123456789');
const crc32: StreamingTrailer = { decodedLength: 9, checksum: 'x-amz-checksum-crc32' };
const crc32c: StreamingTrailer = { decodedLength: 9, checksum: 'x-amz-checksum-crc32c' };

describe('the aws-chunked decoder', () => {
  it('decodes a body and accepts the published CRC-32 and CRC-32C check values', async () => {
    expect(await decode(encode(nine, 'x-amz-checksum-crc32', CRC32_CHECK), crc32)).toEqual(nine);
    expect(await decode(encode(nine, 'x-amz-checksum-crc32c', CRC32C_CHECK), crc32c)).toEqual(nine);
  });

  it('accepts a SHA-1 and a SHA-256 trailer', async () => {
    for (const [name, algorithm] of [
      ['x-amz-checksum-sha1', 'sha1'],
      ['x-amz-checksum-sha256', 'sha256'],
    ] as const) {
      const value = createHash(algorithm).update(nine).digest('base64');
      const expected: StreamingTrailer = { decodedLength: 9, checksum: name };
      expect(await decode(encode(nine, name, value), expected)).toEqual(nine);
    }
  });

  it('decodes the same bytes however the wire is cut, one byte at a time included', async () => {
    const wire = encode(nine, 'x-amz-checksum-crc32c', CRC32C_CHECK, 3);
    for (const slice of [1, 2, 5, wire.length]) {
      expect(await decode(wire, crc32c, slice)).toEqual(nine);
    }
  });

  it('decodes an empty body', async () => {
    const empty = createHash('sha256').update('').digest('base64');
    const expected: StreamingTrailer = { decodedLength: 0, checksum: 'x-amz-checksum-sha256' };
    expect(await decode(encode(Buffer.alloc(0), 'x-amz-checksum-sha256', empty), expected)).toEqual(
      Buffer.alloc(0)
    );
  });

  it('refuses a checksum that is not the one of the bytes', async () => {
    const wrong = Buffer.from([0, 0, 0, 1]).toString('base64');
    await expect(decode(encode(nine, 'x-amz-checksum-crc32', wrong), crc32)).rejects.toThrow(
      /checksum does not match/
    );
  });

  it('refuses a body altered after it was summed', async () => {
    const wire = encode(nine, 'x-amz-checksum-crc32c', CRC32C_CHECK);
    wire[wire.indexOf('2')] = 'X'.charCodeAt(0);
    await expect(decode(wire, crc32c)).rejects.toThrow();
  });

  it('refuses a trailer that names another checksum than the headers declared', async () => {
    await expect(decode(encode(nine, 'x-amz-checksum-crc32', CRC32_CHECK), crc32c)).rejects.toThrow(
      /not the declared checksum/
    );
  });

  it('refuses fewer or more bytes than declared', async () => {
    await expect(
      decode(encode(nine, 'x-amz-checksum-crc32c', CRC32C_CHECK), { ...crc32c, decodedLength: 10 })
    ).rejects.toThrow(/fewer bytes/);
    await expect(
      decode(encode(nine, 'x-amz-checksum-crc32c', CRC32C_CHECK), { ...crc32c, decodedLength: 8 })
    ).rejects.toThrow(/more bytes/);
  });

  it('refuses a malformed frame: a size with an extension, a signature, no trailer, a cut-off chunk', async () => {
    const good = encode(nine, 'x-amz-checksum-crc32c', CRC32C_CHECK, 9).toString('latin1');
    for (const bad of [
      good.replace('9\r\n', '9;chunk-signature=ab\r\n'),
      good.replace('9\r\n', 'zz\r\n'),
      good.replace('9\r\n', '9\n'),
      good.replace(/0\r\nx-amz.*$/s, '0\r\n\r\n'),
      good.slice(0, 14),
      good.replace('123456789\r\n', '123456789XY'),
    ]) {
      await expect(decode(Buffer.from(bad, 'latin1'), crc32c)).rejects.toThrow();
    }
  });

  it('refuses a trailer that runs on', async () => {
    const wire = Buffer.concat([
      Buffer.from('0\r\n'),
      Buffer.from(`x-amz-checksum-crc32:${'A'.repeat(400)}\r\n\r\n`),
    ]);
    await expect(
      decode(wire, { decodedLength: 0, checksum: 'x-amz-checksum-crc32' })
    ).rejects.toThrow(/trailer too long/);
  });
});

describe('the streaming headers', () => {
  const headers = (over: Record<string, string[] | undefined> = {}) => {
    const base: Record<string, string[] | undefined> = {
      'content-encoding': ['aws-chunked'],
      'x-amz-decoded-content-length': ['9'],
      'x-amz-trailer': ['x-amz-checksum-crc32'],
      ...over,
    };
    return (name: string) => base[name];
  };

  it('names the marker the SDK sends', () => {
    expect(STREAMING_UNSIGNED_TRAILER).toBe('STREAMING-UNSIGNED-PAYLOAD-TRAILER');
  });

  it('reads the one form the SDK sends', () => {
    expect(parseStreamingTrailer(headers())).toEqual({
      decodedLength: 9,
      checksum: 'x-amz-checksum-crc32' satisfies ChecksumHeader,
    });
    expect(parseStreamingTrailer(headers({ 'x-amz-trailer': ['X-Amz-Checksum-CRC32C'] }))).toEqual({
      decodedLength: 9,
      checksum: 'x-amz-checksum-crc32c',
    });
  });

  it('refuses every other form', () => {
    for (const over of [
      { 'content-encoding': undefined },
      { 'content-encoding': ['gzip'] },
      { 'content-encoding': ['aws-chunked', 'aws-chunked'] },
      { 'x-amz-decoded-content-length': undefined },
      { 'x-amz-decoded-content-length': ['-1'] },
      { 'x-amz-decoded-content-length': ['09'] },
      { 'x-amz-decoded-content-length': ['9', '9'] },
      { 'x-amz-trailer': undefined },
      { 'x-amz-trailer': ['x-amz-meta-anything'] },
    ]) {
      expect(parseStreamingTrailer(headers(over))).toBeUndefined();
    }
  });
});
