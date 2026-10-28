import type { AllowedOperation, Refusal } from '../contracts.js';
import { refusal } from '../refusal.js';
import { WRITE_OPERATIONS, type WriteKillSwitches } from './killswitch.js';
import type { QuotaMonitor } from './quota.js';
import type { TenantRateLimiter } from './rate.js';

export * from './killswitch.js';
export * from './quota.js';
export * from './rate.js';

export type LimitDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: Refusal; readonly retryAfterMs?: number };

/** The gate an admitted request passes before it is forwarded. */
export interface TenantLimits {
  check(request: { readonly keyId: string; readonly operation: AllowedOperation }): LimitDecision;
}

/**
 * The write switches come first and cost no rate allowance, then the rate
 * limit, then the quota watcher, which only observes. A tenant's switch, rate
 * and quota are all keyed by its own key id.
 */
export function createTenantLimits(options: {
  readonly rate: TenantRateLimiter;
  readonly switches: WriteKillSwitches;
  readonly quotas?: QuotaMonitor;
}): TenantLimits {
  return {
    check({ keyId, operation }) {
      if (WRITE_OPERATIONS.has(operation) && options.switches.writesBlocked(keyId)) {
        return { ok: false, refusal: refusal('writes-disabled') };
      }
      const taken = options.rate.take(keyId);
      if (!taken.allowed) {
        return { ok: false, refusal: refusal('rate-limited'), retryAfterMs: taken.retryAfterMs };
      }
      options.quotas?.observe(keyId);
      return { ok: true };
    },
  };
}
