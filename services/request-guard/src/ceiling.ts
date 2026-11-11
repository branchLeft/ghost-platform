/**
 * The per-source attempt ceiling: at most `limit` passphrase attempts per
 * source per fixed window. Every attempt counts, right or wrong -- counting
 * only failures would let an attacker learn which guess was right from
 * whether the counter moved.
 *
 * The table is bounded. What happens to a new source when it is full of
 * live windows is the `onFull` policy. `'refuse'` (the default) turns the new
 * source away rather than admit it uncounted, so a flood of addresses can make
 * the service unavailable but never unmetered. `'evict-oldest'` forgets the
 * source whose window began first and admits the new one, for a caller that
 * must never lock a real visitor out: a flood of addresses can then restart
 * the oldest source's count, but the table never grows past `maxSources`.
 */
type Verdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** What a full table does with a source it holds no window for. */
export type OverflowPolicy = 'refuse' | 'evict-oldest';

export interface AttemptCeiling {
  /** Records an attempt and says whether it may proceed; `retryAfterSeconds` when refused. */
  attempt(key: string, nowMs: number): Verdict;
  /**
   * The verdict `attempt` would give right now, without recording an
   * attempt or creating an entry.
   * See ../README.md#peek-and-the-reclaim-sweep.
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
  /**
   * How many sources currently hold a window, after reclaiming the expired
   * ones. For a caller that reports the table's size; it records nothing.
   */
  size(nowMs: number): number;
}

export interface CeilingOptions {
  readonly limit: number;
  readonly windowMs: number;
  /** At least 1: the most sources the table holds at once. */
  readonly maxSources: number;
  /** What a full table does with a new source; `'refuse'` when omitted. */
  readonly onFull?: OverflowPolicy;
}

export function createAttemptCeiling(options: CeilingOptions): AttemptCeiling {
  const windows = new Map<string, { start: number; count: number }>();
  const onFull: OverflowPolicy = options.onFull ?? 'refuse';

  // Bounded per call: `attempt` keeps `windows` in ascending start-time
  // order (see its own insertion below), so once iteration reaches a live
  // entry every entry after it is at least as new and therefore live too.
  // Stopping there makes a source with no table entry cost O(1) even when
  // the table is full of live windows, not O(table size) -- otherwise a
  // flood of addresses outside the table, none of which a refusal ever
  // adds, could re-walk the whole table on every request.
  const sweep = (nowMs: number): void => {
    for (const [key, entry] of windows) {
      if (nowMs - entry.start >= options.windowMs) windows.delete(key);
      else break;
    }
  };

  // A live (unexpired) entry for `key`, or undefined -- read-only, no
  // mutation, so both `attempt` and `peek` see identical state.
  const liveEntry = (key: string, nowMs: number): { start: number; count: number } | undefined => {
    const entry = windows.get(key);
    return entry && nowMs - entry.start < options.windowMs ? entry : undefined;
  };

  // The verdict for `key` right now, shared by `attempt` and `peek` so the
  // two can never disagree. See ../README.md#why-attempt-and-peek-share-one-decision-path.
  const decide = (key: string, nowMs: number): Verdict => {
    const entry = liveEntry(key, nowMs);
    if (!entry) {
      if (windows.size >= options.maxSources) {
        // The table might just be full of dead windows; reclaim them before
        // refusing a source that would otherwise fit.
        sweep(nowMs);
        if (windows.size >= options.maxSources && onFull === 'refuse') {
          return { allowed: false, retryAfterSeconds: Math.ceil(options.windowMs / 1000) };
        }
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
      const verdict = decide(key, nowMs);
      if (!verdict.allowed) return verdict;
      const entry = liveEntry(key, nowMs);
      if (entry) {
        entry.count += 1;
      } else {
        // Deleting first, even when `key` is merely stale rather than
        // absent, is load-bearing: `Map#set` on a key already present
        // keeps its old iteration position, which would leave a renewed
        // entry's stale (early) slot out of start-time order and let
        // `sweep`'s early exit above stop before it reaches genuinely
        // expired entries that come later in that broken order.
        windows.delete(key);
        // Only `'evict-oldest'` can get here with the table still full, and
        // every entry in it is then live (`decide` swept the dead prefix), so
        // the first key is the one whose window began first: `windows` is in
        // ascending start order. Only `attempt` evicts; `peek` never does.
        if (windows.size >= options.maxSources) {
          const oldest = windows.keys().next();
          if (!oldest.done) windows.delete(oldest.value);
        }
        windows.set(key, { start: nowMs, count: 1 });
      }
      return { allowed: true };
    },
    peek(key, nowMs) {
      return decide(key, nowMs);
    },
    refund(key) {
      const entry = windows.get(key);
      if (entry && entry.count > 0) entry.count -= 1;
    },
    size(nowMs) {
      sweep(nowMs);
      return windows.size;
    },
  };
}
