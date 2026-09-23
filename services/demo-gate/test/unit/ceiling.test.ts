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

describe('peek', () => {
  it('gives the same verdict attempt would, without recording anything', () => {
    const ceiling = createAttemptCeiling({ limit: 2, windowMs: WINDOW, maxSources: 10 });
    expect(ceiling.peek('a', 0)).toEqual({ allowed: true });
    expect(ceiling.peek('a', 0)).toEqual({ allowed: true }); // still true: peek charged nothing
    expect(ceiling.attempt('a', 0)).toEqual({ allowed: true });
    expect(ceiling.peek('a', 0)).toEqual({ allowed: true }); // one of two spent
    expect(ceiling.attempt('a', 0)).toEqual({ allowed: true });
    expect(ceiling.peek('a', 0)).toEqual({ allowed: false, retryAfterSeconds: 60 }); // now spent
    expect(ceiling.attempt('a', 0)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('never creates a table entry, so it cannot fill the table on its own', () => {
    const ceiling = createAttemptCeiling({ limit: 5, windowMs: WINDOW, maxSources: 1 });
    // Fifty distinct sources peeked, none ever attempted: the table stays
    // empty, so all fifty peek as allowed -- checking a verdict is not the
    // same as spending the one slot this table has.
    for (let i = 0; i < 50; i++) expect(ceiling.peek(`source-${i}`, 0).allowed).toBe(true);
    expect(ceiling.attempt('the-only-room', 0).allowed).toBe(true);
    expect(ceiling.attempt('a-second-source', 0)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it('reclaims a table full of expired windows on its own, without attempt ever running', () => {
    // The regression this guards: a caller that always peeks before it
    // ever calls attempt (login()'s own pattern, precisely to avoid
    // charging a ceiling a sibling tier is about to refuse) never gives
    // attempt a chance to sweep. If peek itself never reclaimed capacity,
    // a table that once reached maxSources would refuse every source
    // forever, expired windows or not -- this is the sequence that
    // reproduces it if the reclaim is missing.
    const ceiling = createAttemptCeiling({ limit: 5, windowMs: WINDOW, maxSources: 2 });
    ceiling.attempt('a', 0);
    ceiling.attempt('b', 0);
    // Both windows now expired; nothing has called attempt since, so
    // nothing but peek itself could ever reclaim them.
    const wellPast = WINDOW * 100;
    expect(ceiling.peek('a-new-source', wellPast)).toEqual({ allowed: true });
    // The same table admits a returning source too, not just a new one.
    expect(ceiling.peek('a', wellPast)).toEqual({ allowed: true });
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
