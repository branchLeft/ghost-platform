import { describe, expect, it } from 'vitest';
import { hashApiKey, verifyApiKey, type HashedApiKey } from '../../src/crypto.js';

describe('hashApiKey / verifyApiKey', () => {
  it('round-trips: a key verifies against its own hash', () => {
    const stored = hashApiKey('correct-key');
    expect(verifyApiKey('correct-key', stored)).toBe(true);
  });

  it('rejects the wrong key', () => {
    const stored = hashApiKey('correct-key');
    expect(verifyApiKey('wrong-key', stored)).toBe(false);
  });

  it('rejects an empty-string key against a real hash', () => {
    const stored = hashApiKey('correct-key');
    expect(verifyApiKey('', stored)).toBe(false);
  });

  it('produces a distinct salt (and hash) on every call, even for the same input key', () => {
    const first = hashApiKey('same-key');
    const second = hashApiKey('same-key');
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    // ...but each is still independently self-consistent.
    expect(verifyApiKey('same-key', first)).toBe(true);
    expect(verifyApiKey('same-key', second)).toBe(true);
  });

  it('scrypt parameter sanity: salt and hash are the expected fixed byte lengths in hex', () => {
    const stored = hashApiKey('any-key');
    // 16-byte salt, 64-byte derived key — both hex-encoded (2 chars/byte).
    expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.hash).toMatch(/^[0-9a-f]{128}$/);
  });

  describe('malformed stored hash — must reject, never throw', () => {
    const base = hashApiKey('correct-key');

    it('tampered hash (flipped hex char) is rejected', () => {
      const flippedChar = base.hash[0] === 'f' ? 'e' : 'f';
      const tampered: HashedApiKey = { salt: base.salt, hash: flippedChar + base.hash.slice(1) };
      expect(() => verifyApiKey('correct-key', tampered)).not.toThrow();
      expect(verifyApiKey('correct-key', tampered)).toBe(false);
    });

    it('truncated hash is rejected', () => {
      const truncated: HashedApiKey = { salt: base.salt, hash: base.hash.slice(0, 10) };
      expect(() => verifyApiKey('correct-key', truncated)).not.toThrow();
      expect(verifyApiKey('correct-key', truncated)).toBe(false);
    });

    it('hash with trailing garbage (wrong length) is rejected', () => {
      const overlong: HashedApiKey = { salt: base.salt, hash: base.hash + 'ab' };
      expect(() => verifyApiKey('correct-key', overlong)).not.toThrow();
      expect(verifyApiKey('correct-key', overlong)).toBe(false);
    });

    it('non-hex characters in the stored hash are rejected', () => {
      const badHex: HashedApiKey = { salt: base.salt, hash: 'not-valid-hex-data-!!' };
      expect(() => verifyApiKey('correct-key', badHex)).not.toThrow();
      expect(verifyApiKey('correct-key', badHex)).toBe(false);
    });

    it('empty-string hash is rejected', () => {
      const emptyHash: HashedApiKey = { salt: base.salt, hash: '' };
      expect(() => verifyApiKey('correct-key', emptyHash)).not.toThrow();
      expect(verifyApiKey('correct-key', emptyHash)).toBe(false);
    });

    it('missing hash field (corrupted row) is rejected without throwing', () => {
      const corrupted = { salt: base.salt } as unknown as HashedApiKey;
      expect(() => verifyApiKey('correct-key', corrupted)).not.toThrow();
      expect(verifyApiKey('correct-key', corrupted)).toBe(false);
    });

    it('missing salt field (corrupted row) is rejected without throwing', () => {
      const corrupted = { hash: base.hash } as unknown as HashedApiKey;
      expect(() => verifyApiKey('correct-key', corrupted)).not.toThrow();
      expect(verifyApiKey('correct-key', corrupted)).toBe(false);
    });

    it('non-string salt (corrupted row) is rejected without throwing', () => {
      const corrupted = { salt: 12345, hash: base.hash } as unknown as HashedApiKey;
      expect(() => verifyApiKey('correct-key', corrupted)).not.toThrow();
      expect(verifyApiKey('correct-key', corrupted)).toBe(false);
    });

    it('empty-string salt does not throw and simply fails to verify a hash generated with a real salt', () => {
      const corrupted: HashedApiKey = { salt: '', hash: base.hash };
      expect(() => verifyApiKey('correct-key', corrupted)).not.toThrow();
      expect(verifyApiKey('correct-key', corrupted)).toBe(false);
    });
  });

  describe('timing-safety path', () => {
    it('a length-mismatched stored hash is rejected via the length guard, not a variable-time compare', () => {
      // The derived candidate is always exactly KEY_LENGTH bytes (scrypt is
      // always called with the same length argument); only the stored hash
      // can vary, so this exercises the `candidate.length === expected.length`
      // short-circuit directly.
      const stored = hashApiKey('correct-key');
      const shortStored: HashedApiKey = { salt: stored.salt, hash: stored.hash.slice(0, 20) };
      expect(verifyApiKey('correct-key', shortStored)).toBe(false);
    });

    it('two hashes of different keys with equal-length output still compare correctly', () => {
      const a = hashApiKey('key-a');
      const b = hashApiKey('key-b');
      expect(a.hash.length).toBe(b.hash.length);
      expect(verifyApiKey('key-a', b)).toBe(false);
      expect(verifyApiKey('key-b', a)).toBe(false);
    });
  });
});
