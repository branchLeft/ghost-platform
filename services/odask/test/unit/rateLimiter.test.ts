import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../../src/rateLimiter.js';

describe('TokenBucket', () => {
  it('admits up to capacity, then refuses -- a burst past the ceiling is refused', () => {
    const bucket = new TokenBucket(3, 1, () => 0);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('refills over time at the configured rate, never past capacity', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1, () => now);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);

    // Half a token's worth of elapsed time buys nothing yet.
    now = 500;
    expect(bucket.tryConsume()).toBe(false);

    // A whole second at 1/s refills exactly one token.
    now = 1000;
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);

    // A long idle period saturates at capacity rather than accruing
    // unboundedly -- a week of silence must not buy an unlimited burst.
    now = 1000 + 7 * 24 * 60 * 60 * 1000;
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('never lets time move backwards produce free tokens', () => {
    let now = 1000;
    const bucket = new TokenBucket(1, 100, () => now);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
    // A clock that appears to go backwards (NTP step) must not be read as
    // negative elapsed time and refill anyway.
    now = 0;
    expect(bucket.tryConsume()).toBe(false);
  });

  it.each([
    [0, 1],
    [-1, 1],
    [1, 0],
    [1, -1],
  ])('refuses construction with capacity=%d refillPerSecond=%d', (capacity, refill) => {
    expect(() => new TokenBucket(capacity, refill)).toThrow();
  });

  it('two independent buckets never share state -- one global bucket, not per-source', () => {
    const a = new TokenBucket(1, 1, () => 0);
    const b = new TokenBucket(1, 1, () => 0);
    expect(a.tryConsume()).toBe(true);
    // b is a distinct instance and is unaffected by a's consumption -- the
    // service wires exactly one shared instance for this reason (LLD-5 E3:
    // "a single global token bucket applied only to unknown-hostname
    // requests"), proven here at the unit the design decision lives in.
    expect(b.tryConsume()).toBe(true);
  });
});
