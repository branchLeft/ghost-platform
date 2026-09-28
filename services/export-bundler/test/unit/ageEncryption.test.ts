import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgeEncryptionError,
  assertAgeRecipient,
  countAgeRecipientStanzas,
  encryptToFile,
  InvalidAgeRecipientError,
  recipientFingerprint,
} from '../../src/ageEncryption.js';
import { decryptAge, encryptAgeTo, generateAgeIdentity, type AgeIdentity } from '../helpers/age.js';

async function writeFakeAge(dir: string, lines: readonly string[]): Promise<string> {
  const path = join(dir, 'fake-age.sh');
  await writeFile(path, ['#!/bin/sh', 'cat > /dev/null', ...lines].join('\n') + '\n');
  await chmod(path, 0o755);
  return path;
}

describe('assertAgeRecipient', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-age-recipient-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a real X25519 recipient from age-keygen', () => {
    expect(() => assertAgeRecipient(generateAgeIdentity(dir).recipient)).not.toThrow();
  });

  it.each([
    [''],
    ['age1'],
    ['age1' + 'q'.repeat(57)],
    ['age1' + 'q'.repeat(59)],
    ['AGE1' + 'q'.repeat(58)],
    ['age1' + 'b'.repeat(58)],
    ['ssh-ed25519 AAAA'],
    ['age1' + 'q'.repeat(58) + ' -r age1' + 'q'.repeat(58)],
  ])('refuses %j', (recipient) => {
    expect(() => assertAgeRecipient(recipient)).toThrow(InvalidAgeRecipientError);
  });
});

describe('recipientFingerprint', () => {
  it('is the SHA-256 of the recipient string, stable and distinct per recipient', () => {
    const a = 'age1' + 'q'.repeat(58);
    const b = 'age1' + 'p'.repeat(58);
    expect(recipientFingerprint(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(recipientFingerprint(a)).toBe(recipientFingerprint(a));
    expect(recipientFingerprint(a)).not.toBe(recipientFingerprint(b));
  });
});

describe('countAgeRecipientStanzas', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-age-count-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('agrees with the real age on one recipient and on two', () => {
    const one = generateAgeIdentity(dir).recipient;
    const twoDir = join(dir, 'second');
    return mkdtemp(twoDir).then((d) => {
      const two = generateAgeIdentity(d).recipient;
      expect(countAgeRecipientStanzas(encryptAgeTo(Buffer.from('x'), [one]))).toBe(1);
      expect(countAgeRecipientStanzas(encryptAgeTo(Buffer.from('x'), [one, two]))).toBe(2);
    });
  });

  it('stops at the header terminator, never counting payload bytes that look like a stanza', () => {
    const header = Buffer.from(
      'age-encryption.org/v1\n-> X25519 abc\nbody\n--- mac\n-> X25519 fake\n'
    );
    expect(countAgeRecipientStanzas(header)).toBe(1);
  });

  it('counts zero for something that is not an age header', () => {
    expect(countAgeRecipientStanzas(Buffer.from('plain text'))).toBe(0);
  });
});

describe('encryptToFile', () => {
  let dir: string;
  let identity: AgeIdentity;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-age-encrypt-'));
    identity = generateAgeIdentity(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a ciphertext the recipient can decrypt, and nothing else', async () => {
    const dest = join(dir, 'out.age');
    await encryptToFile(Buffer.from('tenant data'), identity.recipient, dest);
    expect((await readFile(dest)).includes(Buffer.from('tenant data'))).toBe(false);
    expect(decryptAge(dest, identity.identityPath).toString('utf8')).toBe('tenant data');
  });

  it('refuses a malformed recipient before creating any file', async () => {
    const dest = join(dir, 'out.age');
    await expect(encryptToFile(Buffer.from('x'), 'not-a-recipient', dest)).rejects.toThrow(
      InvalidAgeRecipientError
    );
    expect(await readdir(dir)).not.toContain('out.age');
  });

  it('raises AgeEncryptionError and removes the destination when age fails', async () => {
    const fake = await writeFakeAge(dir, ['echo "fake age: forced failure" >&2', 'exit 1']);
    const dest = join(dir, 'out.age');
    await expect(encryptToFile(Buffer.from('x'), identity.recipient, dest, fake)).rejects.toThrow(
      /age exited 1: fake age: forced failure/
    );
    expect(await readdir(dir)).not.toContain('out.age');
  });

  it('raises AgeEncryptionError and removes the destination when age cannot be started', async () => {
    const dest = join(dir, 'out.age');
    await expect(
      encryptToFile(Buffer.from('x'), identity.recipient, dest, join(dir, 'no-such-age'))
    ).rejects.toThrow(AgeEncryptionError);
    expect(await readdir(dir)).not.toContain('out.age');
  });

  it('refuses, and removes, a ciphertext whose header names two recipients', async () => {
    const fake = await writeFakeAge(dir, [
      "printf 'age-encryption.org/v1\\n-> X25519 a\\nx\\n-> X25519 b\\ny\\n--- mac\\n'",
      'exit 0',
    ]);
    const dest = join(dir, 'out.age');
    await expect(encryptToFile(Buffer.from('x'), identity.recipient, dest, fake)).rejects.toThrow(
      /names 2 recipient\(s\), expected exactly 1/
    );
    expect(await readdir(dir)).not.toContain('out.age');
  });

  it("never lets the ambient environment reach age -- a synthetic marker set here does not appear in the child's", async () => {
    const probe = join(dir, 'env-probe.log');
    const fake = await writeFakeAge(dir, [
      `if [ -n "$EXPORT_BUNDLER_TEST_ENV_PROBE" ]; then echo present > '${probe}'; else echo absent > '${probe}'; fi`,
      "printf 'age-encryption.org/v1\\n-> X25519 a\\nx\\n--- mac\\n'",
    ]);
    process.env.EXPORT_BUNDLER_TEST_ENV_PROBE = 'must-not-leak';
    try {
      await encryptToFile(Buffer.from('x'), identity.recipient, join(dir, 'out.age'), fake);
    } finally {
      delete process.env.EXPORT_BUNDLER_TEST_ENV_PROBE;
    }
    expect((await readFile(probe, 'utf8')).trim()).toBe('absent');
  });

  it('falls back to an empty PATH rather than throwing when this process has none', async () => {
    const saved = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(
        encryptToFile(Buffer.from('x'), identity.recipient, join(dir, 'out.age'))
      ).rejects.toThrow(AgeEncryptionError);
    } finally {
      process.env.PATH = saved;
    }
  });
});
