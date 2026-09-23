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
export interface AttemptCeiling {
  /** Records an attempt and says whether it may proceed; `retryAfterSeconds` when refused. */
  attempt(
    key: string,
    nowMs: number
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number };
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

  return {
    attempt(key, nowMs) {
      let entry = windows.get(key);
      if (entry && nowMs - entry.start >= options.windowMs) {
        windows.delete(key);
        entry = undefined;
      }
      if (!entry) {
        if (windows.size >= options.maxSources) sweep(nowMs);
        if (windows.size >= options.maxSources) {
          return { allowed: false, retryAfterSeconds: Math.ceil(options.windowMs / 1000) };
        }
        entry = { start: nowMs, count: 0 };
        windows.set(key, entry);
      }
      if (entry.count >= options.limit) {
        const remaining = options.windowMs - (nowMs - entry.start);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)) };
      }
      entry.count += 1;
      return { allowed: true };
    },
  };
}
