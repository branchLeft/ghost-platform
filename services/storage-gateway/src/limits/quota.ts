/** What a tenant has used, as the usage meter reports it. */
export interface QuotaUsage {
  readonly requests: number;
  readonly billableBytesIn: number;
  readonly billableBytesOut: number;
}

export interface UsageSource {
  totalFor(keyId: string): QuotaUsage;
}

export type QuotaDimension = keyof QuotaUsage;

/** A quota: any dimension left out is not limited. */
export type QuotaLimits = Partial<Record<QuotaDimension, number>>;

export interface QuotaAlert {
  readonly keyId: string;
  readonly dimension: QuotaDimension;
  readonly limit: number;
  readonly used: number;
}

export interface QuotaAlerts {
  quotaCrossed(alert: QuotaAlert): void;
}

export interface QuotaMonitor {
  /** Looks at the tenant's usage and raises an alert for each quota newly crossed. Never refuses. */
  observe(keyId: string): void;
  /** Re-arms a tenant's alerts, for the start of a new allowance period. */
  reset(keyId: string): void;
}

const DIMENSIONS: readonly QuotaDimension[] = ['requests', 'billableBytesIn', 'billableBytesOut'];

/**
 * Quotas that only alert. Allowances wait for tier pricing, so crossing one
 * raises one alert per tenant and dimension and changes nothing about how
 * requests are answered: this type has no way to say "refuse".
 */
export function createQuotaMonitor(options: {
  readonly usage: UsageSource;
  readonly alerts: QuotaAlerts;
  readonly default?: QuotaLimits;
  readonly overrides?: Readonly<Record<string, QuotaLimits>>;
}): QuotaMonitor {
  const overrides = new Map(Object.entries(options.overrides ?? {}));
  for (const limits of [options.default ?? {}, ...overrides.values()]) {
    for (const value of Object.values(limits)) {
      if (!Number.isFinite(value) || (value as number) < 0) {
        throw new RangeError('a quota must be a non-negative, finite number');
      }
    }
  }
  const raised = new Set<string>();
  const marker = (keyId: string, dimension: QuotaDimension): string =>
    JSON.stringify([keyId, dimension]);

  return {
    observe(keyId) {
      const limits = overrides.get(keyId) ?? options.default;
      if (limits === undefined) return;
      const used = options.usage.totalFor(keyId);
      for (const dimension of DIMENSIONS) {
        const limit = limits[dimension];
        if (limit === undefined || used[dimension] <= limit) continue;
        const mark = marker(keyId, dimension);
        if (raised.has(mark)) continue;
        raised.add(mark);
        options.alerts.quotaCrossed({ keyId, dimension, limit, used: used[dimension] });
      }
    },
    reset(keyId) {
      for (const dimension of DIMENSIONS) raised.delete(marker(keyId, dimension));
    },
  };
}
