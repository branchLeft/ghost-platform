import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeOutcomeMessageId,
  encodeOutcomeMessageId,
  signOutcomeMessageId,
  verifyOutcomeMessageId,
} from '../../src/outcomeId.js';

describe('outcomeId', () => {
  it('round-trips a message, generation and spool, including a spool id with dots and unicode', () => {
    for (const targetId of ['tenant-a', 'demo.site.01', 'café']) {
      const key = { targetId, id: '4cfbf575-9efc-4508-bc4f-e0f9314e4844', drainCount: 3 };
      expect(decodeOutcomeMessageId(encodeOutcomeMessageId(key))).toEqual(key);
    }
  });

  it('is under the reserved .invalid TLD, so it can never be a routable domain', () => {
    const id = encodeOutcomeMessageId({ targetId: 't', id: 'a-1', drainCount: 1 });
    expect(id.endsWith('.outcomes.invalid>')).toBe(true);
  });

  it.each([
    '<abc@example.com>',
    '<a-1.0@74.outcomes.invalid>',
    '<a-1.2@zz.outcomes.invalid>',
    '<a-1.2@7.outcomes.invalid>',
    '<a b.2@74.outcomes.invalid>',
    'a-1.2@74.outcomes.invalid',
    '',
  ])('rejects a Message-ID this collector did not mint: %s', (value) => {
    expect(decodeOutcomeMessageId(value)).toBeNull();
  });
});

describe('signed outcome ids', () => {
  const KEY = randomBytes(32).toString('hex');
  const key = { targetId: 'tenant-a', id: '4cfbf575-9efc-4508-bc4f-e0f9314e4844', drainCount: 3 };
  const signed = signOutcomeMessageId(key, 'Reader@Example.com', KEY);

  it('verifies for the recipient it was signed for, whatever its case, and still decodes by shape', () => {
    expect(verifyOutcomeMessageId(signed, ['reader@example.com'], KEY)).toEqual(key);
    expect(verifyOutcomeMessageId(signed, ['x@example.com', ' READER@example.com '], KEY)).toEqual(
      key
    );
    expect(decodeOutcomeMessageId(signed)).toEqual(key);
    expect(signed.endsWith('.outcomes.invalid>')).toBe(true);
  });

  it('never verifies an unsigned id, however well formed', () => {
    expect(
      verifyOutcomeMessageId(encodeOutcomeMessageId(key), ['reader@example.com'], KEY)
    ).toBeNull();
  });

  it('does not verify for another recipient, another key, or no recipient', () => {
    expect(verifyOutcomeMessageId(signed, ['other@example.com'], KEY)).toBeNull();
    expect(
      verifyOutcomeMessageId(signed, ['reader@example.com'], randomBytes(32).toString('hex'))
    ).toBeNull();
    expect(verifyOutcomeMessageId(signed, [], KEY)).toBeNull();
  });

  it('does not verify when the message, generation or spool it names was changed', () => {
    for (const changed of [
      { ...key, drainCount: 4 },
      { ...key, targetId: 'tenant-b' },
      { ...key, id: '4cfbf575-9efc-4508-bc4f-e0f9314e4845' },
    ]) {
      const moved = signOutcomeMessageId(changed, 'reader@example.com', KEY).replace(
        /\.[0-9a-f]{32}@/,
        /\.([0-9a-f]{32})@/.exec(signed)![0]
      );
      expect(verifyOutcomeMessageId(moved, ['reader@example.com'], KEY)).toBeNull();
    }
  });

  it('does not verify a truncated, extended or altered MAC', () => {
    const mac = /\.([0-9a-f]{32})@/.exec(signed)![1]!;
    for (const bad of [
      mac.slice(0, 31),
      mac.slice(0, 16),
      `${mac}0`,
      '0'.repeat(32),
      mac.toUpperCase(),
    ]) {
      expect(
        verifyOutcomeMessageId(signed.replace(mac, bad), ['reader@example.com'], KEY)
      ).toBeNull();
    }
  });

  // A compare that looks at only some bytes passes every test that damages the
  // same byte, so the damage is done at the first, a middle and the last position.
  it.each([
    ['first', 0],
    ['second', 1],
    ['middle', 15],
    ['next to last', 30],
    ['last', 31],
  ])('does not verify when the %s character of the MAC is flipped', (_name, index) => {
    const mac = /\.([0-9a-f]{32})@/.exec(signed)![1]!;
    const flipped = `${mac.slice(0, index)}${mac[index] === '0' ? '1' : '0'}${mac.slice(index + 1)}`;
    expect(flipped).not.toBe(mac);
    expect(
      verifyOutcomeMessageId(signed.replace(mac, flipped), ['reader@example.com'], KEY)
    ).toBeNull();
  });

  it('keeps the fields apart: two different splits of the same text give different MACs', () => {
    const macOf = (id: string): string => /\.([0-9a-f]{32})@/.exec(id)![1]!;
    const sign = (k: typeof key, recipient: string): string =>
      macOf(signOutcomeMessageId(k, recipient, KEY));
    // The id and the generation run together as `a-111` unless they are separated.
    expect(sign({ ...key, id: 'a-1', drainCount: 11 }, 'r@example.com')).not.toBe(
      sign({ ...key, id: 'a-11', drainCount: 1 }, 'r@example.com')
    );
    // The spool and the recipient run together as `tenanta@x.com` unless they are separated.
    expect(sign({ ...key, targetId: 'tenant' }, 'a@x.com')).not.toBe(
      sign({ ...key, targetId: 'tenanta' }, '@x.com')
    );
    // The generation and the spool.
    expect(sign({ ...key, drainCount: 1, targetId: '2a' }, 'r@example.com')).not.toBe(
      sign({ ...key, drainCount: 12, targetId: 'a' }, 'r@example.com')
    );
  });

  it('refuses a key that is too short to be one, without echoing it', () => {
    expect(() => signOutcomeMessageId(key, 'reader@example.com', 'short-secret')).toThrow(
      /at least 32 characters/
    );
    expect(() => signOutcomeMessageId(key, 'reader@example.com', 'short-secret')).not.toThrow(
      /short-secret/
    );
  });
});
