import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMETERS,
  HashFormatError,
  hashPassphrase,
  parseArgon2idHash,
  verifyPassphrase,
} from '../../src/argon2id.js';

const FAST = { memoryKiB: 8192, passes: 1, parallelism: 1 };
const SALT = 'c2FsdHNhbHRzYWx0c2FsdA';
const TAG = 'dGFndGFndGFndGFndGFndGFndGFndGFndGFndGFndGE';

describe('hashPassphrase and verifyPassphrase', () => {
  it('verifies the passphrase a hash was minted from', async () => {
    const hash = parseArgon2idHash(await hashPassphrase('correct horse', FAST));
    expect(await verifyPassphrase('correct horse', hash)).toBe(true);
  });

  it('refuses a different passphrase, including one differing by a single character', async () => {
    const hash = parseArgon2idHash(await hashPassphrase('correct horse', FAST));
    expect(await verifyPassphrase('correct hors', hash)).toBe(false);
    expect(await verifyPassphrase('correct horsf', hash)).toBe(false);
    expect(await verifyPassphrase('', hash)).toBe(false);
  });

  it('salts every hash, so one passphrase never hashes the same twice', async () => {
    expect(await hashPassphrase('x', FAST)).not.toBe(await hashPassphrase('x', FAST));
  });

  it('mints with the default parameters when none are given', async () => {
    const hash = parseArgon2idHash(await hashPassphrase('x'));
    expect(hash).toMatchObject(DEFAULT_PARAMETERS);
    expect(hash.salt).toHaveLength(16);
    expect(hash.tag).toHaveLength(32);
  });

  it('verifies a hash minted by an independent encoder (RFC 9106 parameters, reference output)', async () => {
    // The example in the reference implementation's README (phc-winner-argon2): password "password", salt "somesalt", -id -t 2 -k 65536 -p 1 -l 32.
    const hash = parseArgon2idHash(
      '$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc'
    );
    expect(await verifyPassphrase('password', hash)).toBe(true);
    expect(await verifyPassphrase('passwore', hash)).toBe(false);
  });
});

describe('parseArgon2idHash', () => {
  it('parses a canonical PHC string', () => {
    const hash = parseArgon2idHash(`$argon2id$v=19$m=65536,t=3,p=4$${SALT}$${TAG}`);
    expect(hash).toMatchObject({ memoryKiB: 65536, passes: 3, parallelism: 4 });
    expect(hash.salt.toString()).toBe('saltsaltsaltsalt');
  });

  it.each([
    ['argon2i', `$argon2i$v=19$m=65536,t=3,p=4$${SALT}$${TAG}`],
    ['argon2d', `$argon2d$v=19$m=65536,t=3,p=4$${SALT}$${TAG}`],
    ['version 16', `$argon2id$v=16$m=65536,t=3,p=4$${SALT}$${TAG}`],
    ['no version', `$argon2id$m=65536,t=3,p=4$${SALT}$${TAG}`],
    ['reordered parameters', `$argon2id$v=19$t=3,m=65536,p=4$${SALT}$${TAG}`],
    ['padded base64', `$argon2id$v=19$m=65536,t=3,p=4$${SALT}==$${TAG}`],
    ['trailing text', `$argon2id$v=19$m=65536,t=3,p=4$${SALT}$${TAG}$x`],
    ['memory below the floor', `$argon2id$v=19$m=4096,t=3,p=4$${SALT}$${TAG}`],
    ['memory above the ceiling', `$argon2id$v=19$m=4194304,t=3,p=4$${SALT}$${TAG}`],
    ['too many passes', `$argon2id$v=19$m=65536,t=11,p=4$${SALT}$${TAG}`],
    ['too many lanes', `$argon2id$v=19$m=65536,t=3,p=9$${SALT}$${TAG}`],
    ['a short salt', `$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$${TAG}`],
    ['a short tag', `$argon2id$v=19$m=65536,t=3,p=4$${SALT}$dGFn`],
    ['an impossible base64 length', `$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2Fsd$${TAG}`],
    ['non-canonical trailing bits', `$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdB$${TAG}`],
    ['plain text', 'demo-pass-1234'],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    expect(() => parseArgon2idHash(value)).toThrow(HashFormatError);
  });

  it('refuses a non-string', () => {
    expect(() => parseArgon2idHash(42 as unknown as string)).toThrow(HashFormatError);
  });
});
