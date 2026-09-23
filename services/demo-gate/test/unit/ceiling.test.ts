import { describe, expect, it } from 'vitest';
import { createAttemptCeiling } from '../../src/ceiling.js';

const WINDOW = 60_000;

describe('createAttemptCeiling', () => {
  it('allows exactly `limit` attempts per window, then refuses', () => {
    const ceiling = createAttemptCeiling({ limit: 3, windowMs: WINDOW, maxSources: 10 });
    expect([1, 2, 3].map(() => ceiling.attempt('a', 0).allowed)).toEqual([true, true, true]);
    expect(ceiling.attempt('a', 1000)).toEqual({ allowed: false, retryAfterSeconds: 59 });
  });

  it('keeps sources independent', () => {
    const ceiling = createAttemptCeiling({ limit: 1, windowMs: WINDOW, maxSources: 10 });
    expect(ceiling.attempt('a', 0).allowed).toBe(true);
    expect(ceiling.attempt('a', 0).allowed).toBe(false);
    expect(ceiling.attempt('b', 0).allowed).toBe(true);
  });

  it('opens a fresh window once the old one has elapsed', () => {
    const ceiling = createAttemptCeiling({ limit: 1, windowMs: WINDOW, maxSources: 10 });
    ceiling.attempt('a', 0);
    expect(ceiling.attempt('a', WINDOW - 1).allowed).toBe(false);
    expect(ceiling.attempt('a', WINDOW).allowed).toBe(true);
  });

  it('never reports a retry of less than a second', () => {
    const ceiling = createAttemptCeiling({ limit: 1, windowMs: WINDOW, maxSources: 10 });
    ceiling.attempt('a', 0);
    expect(ceiling.attempt('a', WINDOW - 1)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('refuses a new source when the table is full of live windows', () => {
    const ceiling = createAttemptCeiling({ limit: 5, windowMs: WINDOW, maxSources: 2 });
    ceiling.attempt('a', 0);
    ceiling.attempt('b', 0);
    expect(ceiling.attempt('c', 1)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(ceiling.attempt('a', 1).allowed).toBe(true);
  });

  it('reclaims expired windows before refusing a new source', () => {
    const ceiling = createAttemptCeiling({ limit: 5, windowMs: WINDOW, maxSources: 2 });
    ceiling.attempt('a', 0);
    ceiling.attempt('b', 10);
    expect(ceiling.attempt('c', WINDOW + 5).allowed).toBe(true);
  });
});
