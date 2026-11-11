import { describe, expect, it } from 'vitest';
import { planFirstSends } from '../../src/firstSendPlan.js';

function addresses(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `member${i}@example.com`);
}

describe('planFirstSends', () => {
  it('caps each batch at a quarter of the day cap by default', () => {
    const plan = planFirstSends({ accepted: addresses(250), dayCap: 400 });
    expect(plan.batchSize).toBe(100);
    expect(plan.batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it('rounds the batch size down', () => {
    const plan = planFirstSends({ accepted: addresses(10), dayCap: 10 });
    expect(plan.batchSize).toBe(2);
    expect(plan.batches.map((b) => b.length)).toEqual([2, 2, 2, 2, 2]);
  });

  it('does not lose a unit to floating point when the share is exact in decimal', () => {
    const plan = planFirstSends({ accepted: addresses(1), dayCap: 100, share: 0.29 });
    expect(plan.batchSize).toBe(29);
  });

  it('keeps the input order when there is no engagement data', () => {
    const list = addresses(3);
    const plan = planFirstSends({ accepted: list, dayCap: 12 });
    expect(plan.batches).toEqual([list]);
  });

  it('sends the most engaged members first and unscored members last', () => {
    const plan = planFirstSends({
      accepted: ['low@example.com', 'none@example.com', 'top@example.com', 'mid@example.com'],
      engagement: new Map([
        ['top@example.com', 9],
        ['low@example.com', 1],
        ['mid@example.com', 5],
      ]),
      dayCap: 4,
      share: 1,
    });
    expect(plan.batches).toEqual([
      ['top@example.com', 'mid@example.com', 'low@example.com', 'none@example.com'],
    ]);
  });

  it('matches engagement keys case-insensitively', () => {
    const plan = planFirstSends({
      accepted: ['a@example.com', 'B@Example.com'],
      engagement: new Map([['b@example.com', 3]]),
      dayCap: 2,
      share: 1,
    });
    expect(plan.batches).toEqual([['B@Example.com', 'a@example.com']]);
  });

  it('returns no batches for an empty list', () => {
    expect(planFirstSends({ accepted: [], dayCap: 0 }).batches).toEqual([]);
  });

  it('refuses a day cap too small for one member per batch', () => {
    expect(() => planFirstSends({ accepted: addresses(1), dayCap: 3 })).toThrow(RangeError);
  });

  it('refuses a share outside (0, 1]', () => {
    expect(() => planFirstSends({ accepted: addresses(1), dayCap: 10, share: 0 })).toThrow(
      RangeError
    );
    expect(() => planFirstSends({ accepted: addresses(1), dayCap: 10, share: 1.5 })).toThrow(
      RangeError
    );
  });
});
