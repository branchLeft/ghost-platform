/**
 * A single global token bucket, applied only to requests for a hostname the
 * served set does not contain (LLD-5 E3: Caddy's own on-demand-issuance
 * throttle no longer exists, so the ceiling moves into this service). A
 * served hostname is never throttled -- it is a legitimate, bounded-cost
 * `Set.has()` regardless of rate.
 *
 * The bucket is two numbers (`tokens`, `lastRefillMs`), not a per-hostname
 * or per-source map: a burst of many *different* unknown names costs the
 * same one decrement each, so nothing here grows with how many distinct
 * names an attacker tries -- refused without growing memory, not merely
 * refused behind a large enough cap.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now: () => number = Date.now
  ) {
    if (capacity <= 0 || refillPerSecond <= 0) {
      throw new Error('TokenBucket capacity and refillPerSecond must both be positive');
    }
    this.tokens = capacity;
    this.lastRefillMs = now();
    this.now = now;
  }

  private readonly now: () => number;

  /** Consumes one token if available. Returns whether the caller may proceed. */
  tryConsume(): boolean {
    const nowMs = this.now();
    const elapsedSeconds = Math.max(0, nowMs - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = nowMs;

    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}
