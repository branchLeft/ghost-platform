import { describe, expect, it } from 'vitest';
import { decodeOutcomeMessageId, encodeOutcomeMessageId } from '../../src/outcomeId.js';

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
