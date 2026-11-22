import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { crc32 } from 'node:zlib';

/** The payload marker of a body sent as `aws-chunked` over TLS with a checksum in its trailer and no per-chunk signatures. */
export const STREAMING_UNSIGNED_TRAILER = 'STREAMING-UNSIGNED-PAYLOAD-TRAILER';

export type ChecksumHeader =
  | 'x-amz-checksum-crc32'
  | 'x-amz-checksum-crc32c'
  | 'x-amz-checksum-sha1'
  | 'x-amz-checksum-sha256';

const CHECKSUM_HEADERS: ReadonlySet<string> = new Set<ChecksumHeader>([
  'x-amz-checksum-crc32',
  'x-amz-checksum-crc32c',
  'x-amz-checksum-sha1',
  'x-amz-checksum-sha256',
]);

/** What the headers of a streaming request declare: how many decoded bytes follow and which checksum closes them. */
export interface StreamingTrailer {
  readonly decodedLength: number;
  readonly checksum: ChecksumHeader;
}

/** The trailer section is a name, a colon, a base64 checksum and two line ends: never long. */
const MAX_TRAILER_BYTES = 256;
/** A chunk size is hexadecimal and fits an unsigned 32-bit number. */
const MAX_SIZE_LINE = 8;

const TRAILER_LINE = /^([a-z0-9-]+):([A-Za-z0-9+/]+={0,2})\r\n\r\n$/;
const DECIMAL = /^(0|[1-9][0-9]{0,15})$/;

/**
 * Reads the three headers a streaming body must carry, each exactly once and
 * in the one form the SDK sends: `content-encoding: aws-chunked`, a decimal
 * `x-amz-decoded-content-length`, and a `x-amz-trailer` naming one checksum.
 * Undefined for anything else.
 */
export function parseStreamingTrailer(
  get: (name: string) => readonly string[] | undefined
): StreamingTrailer | undefined {
  const one = (name: string): string | undefined => {
    const values = get(name);
    return values?.length === 1 ? (values[0] as string).trim() : undefined;
  };
  if (one('content-encoding')?.toLowerCase() !== 'aws-chunked') return undefined;
  const length = one('x-amz-decoded-content-length');
  if (length === undefined || !DECIMAL.test(length)) return undefined;
  const trailer = one('x-amz-trailer')?.toLowerCase();
  if (trailer === undefined || !CHECKSUM_HEADERS.has(trailer)) return undefined;
  return { decodedLength: Number(length), checksum: trailer as ChecksumHeader };
}

const CRC32C_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32c(chunk: Uint8Array, previous: number): number {
  let c = ~previous >>> 0;
  for (const byte of chunk) c = (CRC32C_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}

interface Checksum {
  update(chunk: Buffer): void;
  base64(): string;
}

function checksumFor(name: ChecksumHeader): Checksum {
  if (name === 'x-amz-checksum-sha1' || name === 'x-amz-checksum-sha256') {
    const hash = createHash(name === 'x-amz-checksum-sha1' ? 'sha1' : 'sha256');
    return { update: (c) => void hash.update(c), base64: () => hash.digest('base64') };
  }
  let value = 0;
  const step = name === 'x-amz-checksum-crc32' ? crc32 : crc32c;
  return {
    update: (c) => {
      value = step(c, value);
    },
    base64: () => {
      const out = Buffer.alloc(4);
      out.writeUInt32BE(value >>> 0);
      return out.toString('base64');
    },
  };
}

type Phase = 'size' | 'data' | 'data-end' | 'trailer';

/**
 * Decodes an `aws-chunked` body whose chunks carry no signature, and checks
 * it: every size line is plain hexadecimal, the decoded bytes add up to the
 * declared length, and the checksum in the trailer is the one of the bytes
 * that arrived. Anything else ends the stream with an error, so a short,
 * long, mangled or altered body never reaches the shard.
 *
 * The signature covers the headers, not these bytes, and the trailer is not
 * signed either: the checksum finds a damaged body, and only TLS in front of
 * the process keeps a body from being replaced.
 */
export function createUnsignedTrailerDecoder(expected: StreamingTrailer): Transform {
  const checksum = checksumFor(expected.checksum);
  let phase: Phase = 'size';
  let line = '';
  let remaining = 0;
  let total = 0;
  let afterCr = false;
  let trailer = '';

  const fail = (reason: string): Error => new Error(`aws-chunked body refused: ${reason}`);

  return new Transform({
    transform(chunk: Buffer, _encoding: string, done: TransformCallback): void {
      try {
        let at = 0;
        while (at < chunk.length) {
          if (phase === 'size') {
            const byte = chunk[at] as number;
            at += 1;
            if (afterCr) {
              if (byte !== 0x0a) throw fail('size line not ended by a line feed');
              afterCr = false;
              if (line === '') throw fail('empty size line');
              remaining = Number.parseInt(line, 16);
              line = '';
              if (remaining === 0) {
                phase = 'trailer';
              } else {
                if (total + remaining > expected.decodedLength)
                  throw fail('more bytes than declared');
                phase = 'data';
              }
            } else if (byte === 0x0d) {
              afterCr = true;
            } else {
              const ch = String.fromCharCode(byte);
              if (!/[0-9a-fA-F]/.test(ch) || line.length >= MAX_SIZE_LINE) {
                throw fail('size line not plain hexadecimal');
              }
              line += ch;
            }
          } else if (phase === 'data') {
            const take = Math.min(remaining, chunk.length - at);
            const piece = chunk.subarray(at, at + take);
            checksum.update(piece);
            this.push(piece);
            at += take;
            remaining -= take;
            total += take;
            if (remaining === 0) {
              phase = 'data-end';
              line = '';
            }
          } else if (phase === 'data-end') {
            const byte = chunk[at] as number;
            at += 1;
            line += String.fromCharCode(byte);
            if (line.length === 2) {
              if (line !== '\r\n') throw fail('chunk not ended by a line end');
              line = '';
              phase = 'size';
            }
          } else {
            trailer += chunk.subarray(at).toString('latin1');
            at = chunk.length;
            if (trailer.length > MAX_TRAILER_BYTES) throw fail('trailer too long');
          }
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done: TransformCallback): void {
      try {
        if (phase !== 'trailer') throw fail('ended inside a chunk');
        if (total !== expected.decodedLength) throw fail('fewer bytes than declared');
        const match = TRAILER_LINE.exec(lowerName(trailer));
        if (match === null || match[1] !== expected.checksum)
          throw fail('trailer not the declared checksum');
        if (match[2] !== checksum.base64()) throw fail('checksum does not match the bytes');
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

/** Lower-cases only the header name of a trailer line, so the base64 value keeps its case. */
function lowerName(trailer: string): string {
  const colon = trailer.indexOf(':');
  return colon === -1 ? trailer : trailer.slice(0, colon).toLowerCase() + trailer.slice(colon);
}
