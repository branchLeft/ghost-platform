/**
 * A single global token bucket for unserved-hostname requests (LLD-5 E3).
 * Two numbers, not a per-hostname map, so a burst of many different
 * unknown names costs memory nothing extra per name.
 * See ../README.md#ratelimiter-tokenbucket.
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
