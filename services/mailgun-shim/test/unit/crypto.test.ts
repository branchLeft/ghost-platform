import { describe, expect, it } from 'vitest';
import { hashApiKey, verifyApiKey, type HashedApiKey } from '../../src/crypto.js';

describe('hashApiKey / verifyApiKey', () => {
  it('round-trips: a key verifies against its own hash', async () => {
    const stored = hashApiKey('correct-key');
    await expect(verifyApiKey('correct-key', stored)).resolves.toBe(true);
  });

  it('rejects the wrong key', async () => {
    const stored = hashApiKey('correct-key');
    await expect(verifyApiKey('wrong-key', stored)).resolves.toBe(false);
  });

  it('rejects an empty-string key against a real hash', async () => {
    const stored = hashApiKey('correct-key');
    await expect(verifyApiKey('', stored)).resolves.toBe(false);
  });

  it('produces a distinct salt (and hash) on every call, even for the same input key', async () => {
    const first = hashApiKey('same-key');
    const second = hashApiKey('same-key');
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    // ...but each is still independently self-consistent.
    await expect(verifyApiKey('same-key', first)).resolves.toBe(true);
    await expect(verifyApiKey('same-key', second)).resolves.toBe(true);
  });

  it('scrypt parameter sanity: salt and hash are the expected fixed byte lengths in hex', () => {
    const stored = hashApiKey('any-key');
    // 16-byte salt, 64-byte derived key — both hex-encoded (2 chars/byte).
    expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.hash).toMatch(/^[0-9a-f]{128}$/);
  });

  describe('malformed stored hash — must reject, never throw', () => {
    const base = hashApiKey('correct-key');

    it('tampered hash (flipped hex char) is rejected', async () => {
      const flippedChar = base.hash[0] === 'f' ? 'e' : 'f';
      const tampered: HashedApiKey = { salt: base.salt, hash: flippedChar + base.hash.slice(1) };
      // .resolves requires the promise to fulfil (not reject), so this
      // proves the rejection path is never taken as well as asserting the
      // result — the async equivalent of the old `not.toThrow()` pairing.
      await expect(verifyApiKey('correct-key', tampered)).resolves.toBe(false);
    });

    it('truncated hash is rejected', async () => {
      const truncated: HashedApiKey = { salt: base.salt, hash: base.hash.slice(0, 10) };
      await expect(verifyApiKey('correct-key', truncated)).resolves.toBe(false);
    });

    it('hash with trailing garbage (wrong length) is rejected', async () => {
      const overlong: HashedApiKey = { salt: base.salt, hash: base.hash + 'ab' };
      await expect(verifyApiKey('correct-key', overlong)).resolves.toBe(false);
    });

    it('non-hex characters in the stored hash are rejected', async () => {
      const badHex: HashedApiKey = { salt: base.salt, hash: 'not-valid-hex-data-!!' };
      await expect(verifyApiKey('correct-key', badHex)).resolves.toBe(false);
    });

    it('empty-string hash is rejected', async () => {
      const emptyHash: HashedApiKey = { salt: base.salt, hash: '' };
      await expect(verifyApiKey('correct-key', emptyHash)).resolves.toBe(false);
    });

    it('missing hash field (corrupted row) is rejected without throwing', async () => {
      const corrupted = { salt: base.salt } as unknown as HashedApiKey;
      await expect(verifyApiKey('correct-key', corrupted)).resolves.toBe(false);
    });

    it('missing salt field (corrupted row) is rejected without throwing', async () => {
      const corrupted = { hash: base.hash } as unknown as HashedApiKey;
      await expect(verifyApiKey('correct-key', corrupted)).resolves.toBe(false);
    });

    it('non-string salt (corrupted row) is rejected without throwing', async () => {
      const corrupted = { salt: 12345, hash: base.hash } as unknown as HashedApiKey;
      await expect(verifyApiKey('correct-key', corrupted)).resolves.toBe(false);
    });

    it('empty-string salt does not throw and simply fails to verify a hash generated with a real salt', async () => {
      const corrupted: HashedApiKey = { salt: '', hash: base.hash };
      await expect(verifyApiKey('correct-key', corrupted)).resolves.toBe(false);
    });
  });

  describe('timing-safety path', () => {
    it('a length-mismatched stored hash is rejected via the length guard, not a variable-time compare', async () => {
      // The derived candidate is always exactly KEY_LENGTH bytes (scrypt is
      // always called with the same length argument); only the stored hash
      // can vary, so this exercises the `candidate.length === expected.length`
      // short-circuit directly.
      const stored = hashApiKey('correct-key');
      const shortStored: HashedApiKey = { salt: stored.salt, hash: stored.hash.slice(0, 20) };
      await expect(verifyApiKey('correct-key', shortStored)).resolves.toBe(false);
    });

    it('two hashes of different keys with equal-length output still compare correctly', async () => {
      const a = hashApiKey('key-a');
      const b = hashApiKey('key-b');
      expect(a.hash.length).toBe(b.hash.length);
      await expect(verifyApiKey('key-a', b)).resolves.toBe(false);
      await expect(verifyApiKey('key-b', a)).resolves.toBe(false);
    });
  });
});
