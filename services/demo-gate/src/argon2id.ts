import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/** An `argon2id` hash in PHC string form, parsed and bounds-checked. */
export interface Argon2idHash {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

export class HashFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HashFormatError';
  }
}

// Upper bounds exist because the hash arrives from a file, and a parameter
// set chosen by whoever can write that file is otherwise a way to make every
// guess cost the edge gigabytes and seconds.
const LIMITS = {
  memoryKiB: { min: 8 * 1024, max: 256 * 1024 },
  passes: { min: 1, max: 10 },
  parallelism: { min: 1, max: 8 },
  saltBytes: { min: 8, max: 64 },
  tagBytes: { min: 16, max: 64 },
} as const;

// Only argon2id, only version 19, parameters in the canonical m,t,p order,
// and unpadded standard base64 for the salt and tag -- the one spelling
// every mainstream encoder produces. A narrower grammar means a malformed
// hash is refused where it is read rather than half-understood.
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=([1-9][0-9]{0,9}),t=([1-9][0-9]{0,2}),p=([1-9][0-9]{0,2})\$([A-Za-z0-9+/]{1,128})\$([A-Za-z0-9+/]{1,128})$/;

function decodeUnpaddedBase64(value: string, field: string): Buffer {
  if (value.length % 4 === 1) {
    throw new HashFormatError(`argon2id ${field} is not valid base64.`);
  }
  const decoded = Buffer.from(value, 'base64');
  // Round-trip: Node's decoder silently ignores trailing bits that a
  // canonical encoder would have zeroed, so two strings could decode to one
  // value. Only the canonical one is accepted.
  if (decoded.toString('base64').replace(/=+$/, '') !== value) {
    throw new HashFormatError(`argon2id ${field} is not canonical base64.`);
  }
  return decoded;
}

function inRange(value: number, bounds: { min: number; max: number }, field: string): number {
  if (value < bounds.min || value > bounds.max) {
    throw new HashFormatError(`argon2id ${field} ${value} is outside ${bounds.min}-${bounds.max}.`);
  }
  return value;
}

export function parseArgon2idHash(phc: string): Argon2idHash {
  if (typeof phc !== 'string') {
    throw new HashFormatError('argon2id hash must be a string.');
  }
  const match = PHC_PATTERN.exec(phc);
  if (!match) {
    throw new HashFormatError(
      'argon2id hash must be a PHC string: $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<tag>.'
    );
  }
  const [, m, t, p, saltB64, tagB64] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const parallelism = inRange(Number(p), LIMITS.parallelism, 'parallelism');
  const memoryKiB = inRange(Number(m), LIMITS.memoryKiB, 'memory');
  const passes = inRange(Number(t), LIMITS.passes, 'passes');
  const salt = decodeUnpaddedBase64(saltB64, 'salt');
  const tag = decodeUnpaddedBase64(tagB64, 'tag');
  inRange(salt.length, LIMITS.saltBytes, 'salt length');
  inRange(tag.length, LIMITS.tagBytes, 'tag length');
  return { memoryKiB, passes, parallelism, salt, tag };
}

function derive(message: Buffer, hash: Omit<Argon2idHash, 'tag'>, tagLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message,
        nonce: hash.salt,
        parallelism: hash.parallelism,
        tagLength,
        memory: hash.memoryKiB,
        passes: hash.passes,
      },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

/**
 * True only when `passphrase` derives exactly `hash.tag`. The comparison is
 * constant-time over equal-length buffers, and the derivation always runs to
 * completion, so the time taken depends on the hash's parameters and never
 * on how close the guess was.
 */
export async function verifyPassphrase(passphrase: string, hash: Argon2idHash): Promise<boolean> {
  const derived = await derive(Buffer.from(passphrase, 'utf8'), hash, hash.tag.length);
  return derived.length === hash.tag.length && timingSafeEqual(derived, hash.tag);
}

function encodeUnpadded(value: Buffer): string {
  return value.toString('base64').replace(/=+$/, '');
}

/** The parameters new hashes are minted with: RFC 9106's second recommended option, 64 MiB. */
export const DEFAULT_PARAMETERS = { memoryKiB: 64 * 1024, passes: 3, parallelism: 4 } as const;

export async function hashPassphrase(
  passphrase: string,
  parameters: { memoryKiB: number; passes: number; parallelism: number } = DEFAULT_PARAMETERS
): Promise<string> {
  const salt = randomBytes(16);
  const tag = await derive(Buffer.from(passphrase, 'utf8'), { ...parameters, salt }, 32);
  const { memoryKiB: m, passes: t, parallelism: p } = parameters;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${encodeUnpadded(salt)}$${encodeUnpadded(tag)}`;
}
