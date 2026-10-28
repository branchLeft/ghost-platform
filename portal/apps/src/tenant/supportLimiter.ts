/**
 * A ticket is a real email to a person, and a signed-in tenant admin is
 * trusted but not unbounded: five an hour covers a genuine burst (a ticket,
 * a follow-up, a correction) and stops a stuck script or a hijacked session
 * from flooding the inbox.
 */
export const MAX_TICKETS_PER_WINDOW = 5;
export const WINDOW_SECONDS = 3600;

interface Window {
  readonly startedAt: number;
  readonly taken: number;
}

/**
 * A fixed-window counter per tenant, held in memory and driven by an injected
 * clock in UNIX seconds. A restart forgets it, which only ever lets one more
 * window of tickets through.
 */
export class SupportLimiter {
  readonly #clock: () => number;
  readonly #windows = new Map<string, Window>();

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  /** How many tenants currently hold a window. */
  get trackedTenants(): number {
    return this.#windows.size;
  }

  /** Counts one ticket for the tenant and returns whether it is within the limit. */
  tryTake(tenantId: string): boolean {
    const now = this.#clock();
    this.#prune(now);
    const current = this.#windows.get(tenantId) ?? { startedAt: now, taken: 0 };
    if (current.taken >= MAX_TICKETS_PER_WINDOW) return false;
    this.#windows.set(tenantId, { startedAt: current.startedAt, taken: current.taken + 1 });
    return true;
  }

  #prune(now: number): void {
    for (const [tenantId, window] of this.#windows) {
      if (now - window.startedAt >= WINDOW_SECONDS) this.#windows.delete(tenantId);
    }
  }
}
