import {
  createAttemptCeiling,
  type AttemptCeiling,
} from 'ghost-platform-request-guard/dist/index.js';

/**
 * A ticket is a real email to a person, and a signed-in tenant admin is
 * trusted but not unbounded: five an hour covers a genuine burst (a ticket,
 * a follow-up, a correction) and stops a stuck script or a hijacked session
 * from flooding the inbox.
 */
export const MAX_TICKETS_PER_WINDOW = 5;
export const WINDOW_SECONDS = 3600;
/**
 * Tenants the table holds at once. Past this a tenant with no window yet is
 * refused, never let through uncounted: a ticket is mail, so this limiter fails
 * towards metered.
 */
export const MAX_TRACKED_TENANTS = 10_000;

/**
 * A fixed-window counter per tenant, held in memory and driven by an injected
 * clock in UNIX seconds. A restart forgets it, which only ever lets one more
 * window of tickets through. The counting is the shared request guard's
 * ceiling, with its default policy of refusing a new tenant when full.
 */
export class SupportLimiter {
  readonly #clock: () => number;
  readonly #ceiling: AttemptCeiling;

  constructor(clock: () => number) {
    this.#clock = clock;
    this.#ceiling = createAttemptCeiling({
      limit: MAX_TICKETS_PER_WINDOW,
      windowMs: WINDOW_SECONDS * 1000,
      maxSources: MAX_TRACKED_TENANTS,
    });
  }

  /** How many tenants currently hold a window. */
  get trackedTenants(): number {
    return this.#ceiling.size(this.#clock() * 1000);
  }

  /** Counts one ticket for the tenant and returns whether it is within the limit. */
  tryTake(tenantId: string): boolean {
    return this.#ceiling.attempt(tenantId, this.#clock() * 1000).allowed;
  }
}
