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

describe('refund', () => {
  it('undoes exactly one recorded attempt, restoring room in the window', () => {
    const ceiling = createAttemptCeiling({ limit: 1, windowMs: WINDOW, maxSources: 10 });
    ceiling.attempt('a', 0);
    expect(ceiling.attempt('a', 1).allowed).toBe(false);
    ceiling.refund('a');
    expect(ceiling.attempt('a', 2).allowed).toBe(true);
  });

  it('never takes a window below zero, however many times it is called', () => {
    const ceiling = createAttemptCeiling({ limit: 3, windowMs: WINDOW, maxSources: 10 });
    ceiling.attempt('a', 0);
    ceiling.refund('a');
    ceiling.refund('a');
    ceiling.refund('a');
    // Three refunds against one attempt still leave a fresh window with
    // room for `limit` attempts, not more.
    expect([1, 2, 3].map(() => ceiling.attempt('a', 1).allowed)).toEqual([true, true, true]);
    expect(ceiling.attempt('a', 1).allowed).toBe(false);
  });

  it('is a no-op for a source with no live window', () => {
    const ceiling = createAttemptCeiling({ limit: 1, windowMs: WINDOW, maxSources: 10 });
    expect(() => ceiling.refund('never-attempted')).not.toThrow();
  });

  it('is a no-op once the window has expired and been swept', () => {
    const ceiling = createAttemptCeiling({ limit: 1, windowMs: WINDOW, maxSources: 1 });
    ceiling.attempt('a', 0);
    // A second source forces the table's own sweep at capacity, evicting
    // "a"'s expired window before "b" is admitted.
    expect(ceiling.attempt('b', WINDOW + 1).allowed).toBe(true);
    expect(() => ceiling.refund('a')).not.toThrow();
  });
});
