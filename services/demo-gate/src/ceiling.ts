/**
 * The per-source attempt ceiling: at most `limit` passphrase attempts per
 * source per fixed window. Every attempt counts, right or wrong -- counting
 * only failures would let an attacker learn which guess was right from
 * whether the counter moved.
 *
 * The table is bounded. When it is full of live windows a new source is
 * refused rather than admitted uncounted, so a flood of addresses can make
 * the gate unavailable but never unmetered.
 */
type Verdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface AttemptCeiling {
  /** Records an attempt and says whether it may proceed; `retryAfterSeconds` when refused. */
  attempt(key: string, nowMs: number): Verdict;
  /**
   * The verdict `attempt` would give right now, without recording anything
   * -- no entry created, no count incremented, no table sweep. For a
   * caller checking more than one ceiling before deciding whether to
   * charge any of them: peek every ceiling first, and only call `attempt`
   * on ones that already peeked `allowed`, so a request refused by one
   * ceiling never creates or charges an entry in another.
   */
  peek(key: string, nowMs: number): Verdict;
  /**
   * Undoes exactly one `attempt` recorded for `key` -- for a login refused
   * for a reason that was not the attempter's fault (the derivation gate
   * ran out of capacity), never for a wrong guess, which must still count.
   * A no-op if the window has already expired and been swept, or never
   * existed: refunding is best-effort forgiveness, not a promise that the
   * exact window `attempt` incremented is still the one live now.
   */
  refund(key: string): void;
}

export interface CeilingOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxSources: number;
}

export function createAttemptCeiling(options: CeilingOptions): AttemptCeiling {
  const windows = new Map<string, { start: number; count: number }>();

  const sweep = (nowMs: number): void => {
    for (const [key, entry] of windows) {
      if (nowMs - entry.start >= options.windowMs) windows.delete(key);
    }
  };

  // A live (unexpired) entry for `key`, or undefined -- read-only, no
  // mutation, so both `attempt` and `peek` see identical state.
  const liveEntry = (key: string, nowMs: number): { start: number; count: number } | undefined => {
    const entry = windows.get(key);
    return entry && nowMs - entry.start < options.windowMs ? entry : undefined;
  };

  // The verdict for `key` right now, with no sweep and no mutation --
  // `attempt`'s own first check and the whole of `peek` are both exactly
  // this, so the two can never disagree about what "allowed" means.
  const decide = (key: string, nowMs: number): Verdict => {
    const entry = liveEntry(key, nowMs);
    if (!entry) {
      if (windows.size >= options.maxSources) {
        return { allowed: false, retryAfterSeconds: Math.ceil(options.windowMs / 1000) };
      }
      return { allowed: true };
    }
    if (entry.count >= options.limit) {
      const remaining = options.windowMs - (nowMs - entry.start);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)) };
    }
    return { allowed: true };
  };

  return {
    attempt(key, nowMs) {
      let verdict = decide(key, nowMs);
      // A full table might just be full of dead windows; reclaim them
      // before refusing a source that would otherwise fit. Only worth
      // trying when decide() refused for exactly that reason (no live
      // entry for this key, table at capacity) -- sweeping never changes
      // the verdict for a key that already has one.
      if (!verdict.allowed && !liveEntry(key, nowMs) && windows.size >= options.maxSources) {
        sweep(nowMs);
        verdict = decide(key, nowMs);
      }
      if (!verdict.allowed) return verdict;
      const entry = liveEntry(key, nowMs);
      if (entry) entry.count += 1;
      else windows.set(key, { start: nowMs, count: 1 });
      return { allowed: true };
    },
    peek(key, nowMs) {
      return decide(key, nowMs);
    },
    refund(key) {
      const entry = windows.get(key);
      if (entry && entry.count > 0) entry.count -= 1;
    },
  };
}
