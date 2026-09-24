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
   * The verdict `attempt` would give right now, without recording an
   * attempt -- no entry created for `key`, no count incremented. It may
   * still evict other sources' already-expired windows when the table
   * looks full, the same reclaiming `attempt` itself does: without that,
   * a table that once reached `maxSources` would refuse every source
   * forever, since nothing else ever runs a sweep once every caller peeks
   * before it ever calls `attempt`. For a caller checking more than one
   * ceiling before deciding whether to charge any of them: peek every
   * ceiling first, and only call `attempt` on ones that already peeked
   * `allowed`, so a request refused by one ceiling never creates or
   * charges an entry in another.
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

  // The verdict for `key` right now. `attempt` and `peek` share this whole
  // function, sweep included, so the two can never disagree about what
  // "allowed" means -- `peek` was the regression the sweep's old home (only
  // inside `attempt`) caused: once a table held `maxSources` *expired*
  // windows, `peek` refused every source forever, and `login()` (correctly,
  // per the fix that added `peek`) never reaches `attempt` on a source
  // `peek` has already refused, so nothing was left to reclaim them. The
  // sweep below runs from `peek` too, and is safe to run from a read-only
  // call: it only ever deletes entries `liveEntry` already treats as absent
  // for every verdict, so evicting one changes no decision, only the table's
  // own size.
  const decide = (key: string, nowMs: number): Verdict => {
    const entry = liveEntry(key, nowMs);
    if (!entry) {
      if (windows.size >= options.maxSources) {
        // The table might just be full of dead windows; reclaim them before
        // refusing a source that would otherwise fit.
        sweep(nowMs);
        if (windows.size >= options.maxSources) {
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
  };
}
