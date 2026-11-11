import { readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';
import type { SweegoQuota } from './sendingTarget.js';

/**
 * Why the usage counter did something, as a label. A reason names an event
 * and nothing else: never a tenant, an address or a subject, so a count of
 * reasons can go to a metric or a log line as it is.
 */
export type UsageReason =
  /** A tenant reached 100 percent of its allowance and is latched until month end. */
  | 'tenant-latched'
  /** The messages sent by every tenant together reached the account-wide cap. */
  | 'account-cap-reached'
  /** The UTC calendar month changed and every counter started again from zero. */
  | 'month-rolled'
  /** The state file could not be parsed: usage is unknown, so nothing goes to Sweego for the rest of the month. */
  | 'state-corrupt'
  /** The state file exists but could not be read: treated as `state-corrupt`. */
  | 'state-unreadable'
  /** The state file could not be written: nothing goes to Sweego until a write succeeds. */
  | 'state-write-failed'
  /** The clock reads an earlier month than the stored counters: they are kept, not reset. */
  | 'clock-behind-state'
  /** A tenant asked about carries no allowance, so it is treated as latched. */
  | 'allowance-unknown';

/** One attempt at Sweego, begun before the send and settled once it ends. Settling twice is a no-op. */
export interface UsageSlot {
  /** `true` when Sweego accepted the message: it is counted. Any other end counts nothing. */
  settle(accepted: boolean): void;
}

/** What the collector loop calls around a Sweego attempt. */
export interface SweegoUseCounter {
  /**
   * Called in the same tick as the last quota check, so an attempt in flight
   * counts against the allowance and the account cap before it is accepted.
   */
  begin(tenantId: string): UsageSlot;
}

export interface TenantLatchState {
  tenant: string;
  /** Messages Sweego accepted for this tenant this month. */
  used: number;
  /** The tenant's allowance, or undefined when its route carries none. */
  allowance: number | undefined;
  /** True when this tenant's newsletters go through mx1: its own latch, the account cap, or unknown usage. */
  latched: boolean;
}

export interface AccountState {
  /** The UTC calendar month the counters are for, `YYYY-MM`. */
  month: string;
  total: number;
  accountCap: number;
  capReached: boolean;
  /** Usage was unknown at load: everything is latched until the month changes. */
  degraded: boolean;
}

export interface SweegoUsage extends SweegoQuota, SweegoUseCounter {
  /** Per-tenant latch state, for the signals that read it. A plain function, never a label. */
  tenantLatchState(): readonly TenantLatchState[];
  accountState(): AccountState;
  /** Counts of reasons since this process started. */
  reasons(): Readonly<Partial<Record<UsageReason, number>>>;
}

export interface SweegoUsageOptions {
  /** File on a volume that outlives the process. */
  statePath: string;
  /** Messages per UTC month across every tenant together. A positive integer, set from the Sweego plan. */
  accountCap: number;
  /** The allowance a tenant's route carries, or undefined. Read at each check, so a descriptor change is seen. */
  allowanceOf: (tenantId: string) => number | undefined;
  /** Injectable so a test crosses a month boundary without waiting. */
  now?: () => number;
  /** Called with each reason as it is counted. */
  onReason?: (reason: UsageReason) => void;
}

const STATE_VERSION = 1;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The UTC calendar month of an instant, `YYYY-MM`. */
export function utcMonthOf(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getUTCFullYear()).padStart(4, '0')}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface TenantUse {
  used: number;
  latched: boolean;
}

interface LoadedState {
  month: string;
  degraded: boolean;
  tenants: Map<string, TenantUse>;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseState(raw: string): LoadedState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { version, month, degraded, tenants } = parsed as Record<string, unknown>;
  if (
    version !== STATE_VERSION ||
    typeof month !== 'string' ||
    !MONTH_PATTERN.test(month) ||
    typeof degraded !== 'boolean' ||
    typeof tenants !== 'object' ||
    tenants === null ||
    Array.isArray(tenants)
  ) {
    return undefined;
  }
  const loaded = new Map<string, TenantUse>();
  for (const [tenant, use] of Object.entries(tenants)) {
    if (typeof use !== 'object' || use === null) {
      return undefined;
    }
    const { used, latched } = use as Record<string, unknown>;
    if (!isCount(used) || typeof latched !== 'boolean') {
      return undefined;
    }
    loaded.set(tenant, { used, latched });
  }
  return { month, degraded, tenants: loaded };
}

/**
 * Counts what Sweego accepted, per tenant and in total, by UTC calendar
 * month, and answers the resolver's two questions from it. A tenant latches
 * at 100 percent of its allowance and stays latched until the month changes;
 * the account cap latches every tenant at once. State is rewritten whole and
 * atomically on every change, so a restart picks up where the process left
 * off. Anything that makes usage unknown (an unreadable or corrupt file, a
 * failed write) answers "reached": toward mx1, never toward unlimited
 * Sweego sends. See ../README.md#sweegousage-createsweegousage.
 */
export function createSweegoUsage(options: SweegoUsageOptions): SweegoUsage {
  const { statePath, accountCap, allowanceOf } = options;
  if (!Number.isSafeInteger(accountCap) || accountCap <= 0) {
    throw new Error('the Sweego account cap must be a positive integer');
  }
  const now = options.now ?? Date.now;
  const reasonCounts: Partial<Record<UsageReason, number>> = {};
  const tenants = new Map<string, TenantUse>();
  const pending = new Map<string, number>();
  let pendingTotal = 0;
  let totalUsed = 0;
  let month = utcMonthOf(now());
  let degraded = false;
  let unpersisted = false;
  let clockBehind = false;

  function note(reason: UsageReason): void {
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    options.onReason?.(reason);
  }

  function recount(): void {
    totalUsed = 0;
    for (const use of tenants.values()) {
      totalUsed += use.used;
    }
  }

  function persist(): void {
    try {
      writeFileAtomic(
        statePath,
        JSON.stringify({
          version: STATE_VERSION,
          month,
          degraded,
          tenants: Object.fromEntries(tenants),
        })
      );
      unpersisted = false;
    } catch {
      unpersisted = true;
      note('state-write-failed');
    }
  }

  function load(): void {
    let raw: string;
    try {
      raw = readFileSync(statePath, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') {
        degraded = true;
        note('state-unreadable');
        persist();
      }
      return;
    }
    const loaded = parseState(raw);
    if (loaded === undefined) {
      degraded = true;
      note('state-corrupt');
      persist();
      return;
    }
    month = loaded.month;
    degraded = loaded.degraded;
    for (const [tenant, use] of loaded.tenants) {
      tenants.set(tenant, use);
    }
    recount();
  }

  // Run before every answer: the month is read from the clock each time, so a
  // boundary crossed while idle is seen on the next question.
  function roll(): void {
    const current = utcMonthOf(now());
    if (current > month) {
      month = current;
      tenants.clear();
      totalUsed = 0;
      degraded = false;
      clockBehind = false;
      note('month-rolled');
      persist();
    } else if (current < month) {
      // Never reset on a clock that has gone backwards: keep the counters.
      if (!clockBehind) {
        clockBehind = true;
        note('clock-behind-state');
      }
    } else {
      clockBehind = false;
    }
  }

  // True when usage cannot be trusted; a failed write is retried here, so the
  // block lifts as soon as the state is durable again.
  function blocked(): boolean {
    roll();
    if (unpersisted) {
      persist();
    }
    return degraded || unpersisted;
  }

  function allowanceReached(tenantId: string): boolean {
    if (blocked()) {
      return true;
    }
    const allowance = allowanceOf(tenantId);
    if (allowance === undefined) {
      note('allowance-unknown');
      return true;
    }
    const use = tenants.get(tenantId);
    if (use?.latched === true) {
      return true;
    }
    return (use?.used ?? 0) + (pending.get(tenantId) ?? 0) >= allowance;
  }

  function accountCapReached(): boolean {
    if (blocked()) {
      return true;
    }
    return totalUsed + pendingTotal >= accountCap;
  }

  function accept(tenantId: string): void {
    roll();
    const use = tenants.get(tenantId) ?? { used: 0, latched: false };
    use.used += 1;
    totalUsed += 1;
    tenants.set(tenantId, use);
    const allowance = allowanceOf(tenantId);
    if (!use.latched && allowance !== undefined && use.used >= allowance) {
      use.latched = true;
      note('tenant-latched');
    }
    if (totalUsed === accountCap) {
      note('account-cap-reached');
    }
    persist();
  }

  function begin(tenantId: string): UsageSlot {
    roll();
    pending.set(tenantId, (pending.get(tenantId) ?? 0) + 1);
    pendingTotal += 1;
    let settled = false;
    return {
      settle(accepted: boolean): void {
        if (settled) {
          return;
        }
        settled = true;
        const left = (pending.get(tenantId) ?? 1) - 1;
        if (left > 0) {
          pending.set(tenantId, left);
        } else {
          pending.delete(tenantId);
        }
        pendingTotal -= 1;
        if (accepted) {
          accept(tenantId);
        }
      },
    };
  }

  function tenantLatchState(): readonly TenantLatchState[] {
    const everyoneLatched = blocked() || totalUsed >= accountCap;
    return [...tenants.entries()].map(([tenant, use]) => {
      const allowance = allowanceOf(tenant);
      return {
        tenant,
        used: use.used,
        allowance,
        latched: everyoneLatched || use.latched || allowance === undefined || use.used >= allowance,
      };
    });
  }

  function accountState(): AccountState {
    blocked();
    return {
      month,
      total: totalUsed,
      accountCap,
      capReached: totalUsed >= accountCap,
      degraded,
    };
  }

  load();
  roll();

  return {
    allowanceReached,
    accountCapReached,
    begin,
    tenantLatchState,
    accountState,
    reasons: () => ({ ...reasonCounts }),
  };
}
