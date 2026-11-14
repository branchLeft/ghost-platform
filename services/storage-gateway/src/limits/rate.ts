export interface RateConfig {
  /** Requests a second a tenant may sustain. */
  readonly perSecond: number;
  /** Requests a tenant may make at once after a quiet spell. */
  readonly burst: number;
}

export type RateDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

export interface TenantRateLimiter {
  take(keyId: string): RateDecision;
}

function assertRate(name: string, config: RateConfig): void {
  if (!Number.isFinite(config.perSecond) || config.perSecond <= 0) {
    throw new RangeError(`${name}: perSecond must be a positive, finite number`);
  }
  if (!Number.isFinite(config.burst) || config.burst < 1) {
    throw new RangeError(`${name}: burst must be at least 1`);
  }
}

/**
 * A token bucket per tenant. Each tenant has its own bucket, so one tenant
 * spending its allowance leaves every other tenant's untouched. A bucket
 * starts full; an idle clock that steps backwards mints nothing.
 */
export function createTenantRateLimiter(options: {
  readonly default: RateConfig;
  readonly overrides?: Readonly<Record<string, RateConfig>>;
  readonly nowMs?: () => number;
}): TenantRateLimiter {
  assertRate('default', options.default);
  const overrides = new Map(Object.entries(options.overrides ?? {}));
  for (const [keyId, config] of overrides) assertRate(keyId, config);
  const nowMs = options.nowMs ?? Date.now;
  const buckets = new Map<string, { tokens: number; at: number }>();

  return {
    take(keyId) {
      const config = overrides.get(keyId) ?? options.default;
      const now = nowMs();
      const bucket = buckets.get(keyId) ?? { tokens: config.burst, at: now };
      const elapsed = Math.max(0, now - bucket.at);
      bucket.tokens = Math.min(config.burst, bucket.tokens + (elapsed / 1000) * config.perSecond);
      bucket.at = now;
      buckets.set(keyId, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true };
      }
      return {
        allowed: false,
        retryAfterMs: Math.ceil(((1 - bucket.tokens) / config.perSecond) * 1000),
      };
    },
  };
}
