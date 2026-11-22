import { refusal } from '../refusal.js';
import type { StateOperation } from '../state-profile.js';
import type { LimitDecision } from './index.js';
import type { WriteKillSwitches } from './killswitch.js';
import type { TenantRateLimiter } from './rate.js';

/**
 * The state operations a write switch stops: everything that changes the
 * shard. Reads, existence checks and listings move nothing, so a switch never
 * stops them and an operator can still read a tenant's state with writes off.
 */
export const STATE_WRITE_OPERATIONS: ReadonlySet<StateOperation> = new Set([
  'PutObject',
  'CopyObject',
  'DeleteObject',
]);

/** The gate an admitted state request passes before it is forwarded. */
export interface StateLimits {
  check(request: { readonly keyId: string; readonly operation: StateOperation }): LimitDecision;
}

/** The write switches first, at no cost to the tenant's rate allowance, then the per-credential rate limit. */
export function createStateLimits(options: {
  readonly rate: TenantRateLimiter;
  readonly switches: WriteKillSwitches;
}): StateLimits {
  return {
    check({ keyId, operation }) {
      if (STATE_WRITE_OPERATIONS.has(operation) && options.switches.writesBlocked(keyId)) {
        return { ok: false, refusal: refusal('writes-disabled') };
      }
      const taken = options.rate.take(keyId);
      if (!taken.allowed) {
        return { ok: false, refusal: refusal('rate-limited'), retryAfterMs: taken.retryAfterMs };
      }
      return { ok: true };
    },
  };
}
