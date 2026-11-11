import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';
import { markerAbsent, missingFileVerdict, presentFileTrust, writeMarker } from './stateMarker.js';
import type { StateWitness } from './stateWitness.js';
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
  /** The state file is missing though it was written before: counters are unknown, and every send goes to mx1 until the owner deletes the marker. */
  | 'state-vanished'
  /** The state file's witness on the other mount disagrees with the volume (the volume was replaced, or the witness is gone): treated as `state-vanished`. */
  | 'witness-mismatch'
  /** The state file could not be written: nothing goes to Sweego until a write succeeds. */
  | 'state-write-failed'
  /** The clock reads an earlier month than the stored counters: they are kept, not reset. */
  | 'clock-behind-state'
  /** A tenant asked about carries no allowance, so it is treated as latched. */
  | 'allowance-unknown'
  /** A place reserved before a crash had no outcome recorded, so the next start counted it as used. */
  | 'inflight-recounted';

/** One attempt at Sweego, begun before the send and settled once it ends. Settling twice is a no-op. */
export interface UsageSlot {
  /** `true` when Sweego accepted the message: it is counted. Any other end counts nothing. */
  settle(accepted: boolean): void;
  /**
   * The attempt ended unplaced (a timeout, a failure after DATA): Sweego may
   * have taken it, so it is counted, once per message however it ends later.
   */
  ambiguous(): void;
}

/** What the collector loop calls around a Sweego attempt. */
export interface SweegoUseCounter {
  /**
   * Called in the same tick as the last quota check, so an attempt in flight
   * counts against the allowance and the account cap before it is accepted.
   * `messageId` lets a message that is counted at an ambiguous end be counted
   * only once if a later attempt for it is accepted. The place is written to
   * the state file before this returns; `undefined` means it could not be
   * (the state is unreadable or the write failed), and the caller must not
   * send. A message that already holds a place is given a slot that reserves
   * nothing more.
   */
  begin(tenantId: string, messageId?: string): UsageSlot | undefined;
  /**
   * True when this message was already counted this month (an earlier attempt
   * ended ambiguous, or its reserved place was recounted after a crash), so a
   * retry of it needs no new place. Always false while the counters cannot be
   * trusted.
   */
  holdsPlace(messageId: string): boolean;
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
  /** The state file vanished: everything is latched until the owner deletes the marker. */
  vanished: boolean;
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
  /** Witness kept on a different mount from `statePath`. Absent, only the marker beside the file guards it. */
  witness?: StateWitness;
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

/** A place reserved and not yet settled. The digest is absent when the attempt carried no message id. */
interface InflightEntry {
  tenant: string;
  digest?: string;
}

interface LoadedState {
  month: string;
  degraded: boolean;
  vanished: boolean;
  tenants: Map<string, TenantUse>;
  counted: Set<string>;
  inflight: InflightEntry[];
}

/** An opaque digest, so the file holds no message id. */
function digestOf(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 16);
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
  const { version, month, degraded, tenants, vanished, ambiguous, inflight } = parsed as Record<
    string,
    unknown
  >;
  if (
    version !== STATE_VERSION ||
    typeof month !== 'string' ||
    !MONTH_PATTERN.test(month) ||
    typeof degraded !== 'boolean' ||
    (vanished !== undefined && typeof vanished !== 'boolean') ||
    (ambiguous !== undefined &&
      (!Array.isArray(ambiguous) || !ambiguous.every((entry) => typeof entry === 'string'))) ||
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
  const reserved: InflightEntry[] = [];
  if (inflight !== undefined) {
    if (!Array.isArray(inflight)) {
      return undefined;
    }
    for (const entry of inflight) {
      if (typeof entry !== 'object' || entry === null) {
        return undefined;
      }
      const { tenant, digest } = entry as Record<string, unknown>;
      if (typeof tenant !== 'string' || (digest !== undefined && typeof digest !== 'string')) {
        return undefined;
      }
      reserved.push(digest === undefined ? { tenant } : { tenant, digest });
    }
  }
  return {
    month,
    degraded,
    vanished: vanished === true,
    tenants: loaded,
    counted: new Set(ambiguous as string[] | undefined),
    inflight: reserved,
  };
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
  const { statePath, accountCap, allowanceOf, witness } = options;
  if (!Number.isSafeInteger(accountCap) || accountCap <= 0) {
    throw new Error('the Sweego account cap must be a positive integer');
  }
  const now = options.now ?? Date.now;
  const reasonCounts: Partial<Record<UsageReason, number>> = {};
  const tenants = new Map<string, TenantUse>();
  const pending = new Map<string, number>();
  let pendingTotal = 0;
  // Places reserved and not yet settled. Written to the file with every save,
  // so a crash leaves them there and the next start counts them.
  const inflight = new Set<InflightEntry>();
  let totalUsed = 0;
  let month = utcMonthOf(now());
  let degraded = false;
  // Set when the file vanished; unlike `degraded` it outlasts the month, and
  // only the owner deleting the marker clears it.
  let vanished = false;
  // Digests of the messages counted at an ambiguous end this month.
  let counted = new Set<string>();
  // True once the marker beside the state file is known to exist.
  let markerKnown = false;
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
      // A latch written where the marker is absent (a replaced volume) goes
      // marker first: a file latched with no marker reads as the owner's
      // clearing at the next start, and a marker with no file reads as lost.
      if (vanished && !markerKnown && markerAbsent(statePath)) {
        writeMarker(statePath, witness);
        markerKnown = true;
      }
      writeFileAtomic(
        statePath,
        JSON.stringify({
          version: STATE_VERSION,
          month,
          degraded,
          ...(vanished ? { vanished } : {}),
          tenants: Object.fromEntries(tenants),
          ...(counted.size > 0 ? { ambiguous: [...counted] } : {}),
          ...(inflight.size > 0 ? { inflight: [...inflight] } : {}),
        })
      );
      // Otherwise after the file: a crash between the two leaves a file with no
      // marker, read as an upgrade at the next load, never a marker with no file.
      if (!markerKnown) {
        writeMarker(statePath, witness);
        markerKnown = true;
      }
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
      } else {
        const verdict = missingFileVerdict(statePath, witness);
        if (verdict !== 'first-run') {
          // Written before, so not a first run: the counters are gone and a fresh
          // monthly allowance must not follow. Written down, so a restart keeps it.
          // The marker and witness are written again with the file: a marker lost
          // with a replaced volume must not read as the owner's clearing.
          markerKnown = false;
          vanished = true;
          note(verdict === 'vanished' ? 'state-vanished' : 'witness-mismatch');
          persist();
        }
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
    counted = loaded.counted;
    for (const [tenant, use] of loaded.tenants) {
      tenants.set(tenant, use);
    }
    recount();
    // Places reserved by a process that died before it recorded an outcome:
    // the send may have been taken, so each is counted as used.
    let recounted = false;
    for (const entry of loaded.inflight) {
      if (entry.digest !== undefined) {
        if (counted.has(entry.digest)) {
          recounted = true;
          continue;
        }
        counted.add(entry.digest);
      }
      addUse(entry.tenant);
      note('inflight-recounted');
      recounted = true;
    }
    const trust = presentFileTrust(statePath, witness);
    if (loaded.vanished && markerAbsent(statePath)) {
      // The owner deleted the marker: the latch is cleared, the counts kept.
      persist();
    } else if (loaded.vanished) {
      vanished = true;
      markerKnown = trust === 'trusted';
      note('state-vanished');
    } else if (trust === 'witness-lost') {
      // The witness no longer vouches for this file: the volume may be an old
      // copy or a stand-in. Latched like a vanished file, and written down.
      vanished = true;
      markerKnown = false;
      note('witness-mismatch');
      persist();
    } else if (trust === 'unmarked') {
      // A file from before the marker or witness existed: write them now, so the file's later loss is seen.
      persist();
    } else {
      markerKnown = true;
    }
    // Last, so the file written keeps the vanished latch the branches above settled.
    if (recounted) {
      persist();
    }
  }

  // Run before every answer: the month is read from the clock each time, so a
  // boundary crossed while idle is seen on the next question.
  function roll(): void {
    const current = utcMonthOf(now());
    if (current > month) {
      month = current;
      tenants.clear();
      counted.clear();
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
    return degraded || vanished || unpersisted;
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

  function addUse(tenantId: string): void {
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
  }

  function accept(tenantId: string): void {
    roll();
    addUse(tenantId);
    persist();
  }

  // Ends the reservation in memory.
  function unreserve(tenantId: string, entry: InflightEntry): void {
    inflight.delete(entry);
    const left = (pending.get(tenantId) ?? 1) - 1;
    if (left > 0) {
      pending.set(tenantId, left);
    } else {
      pending.delete(tenantId);
    }
    pendingTotal -= 1;
  }

  // What a message that already holds a place is given: nothing more is reserved or counted.
  const HELD_PLACE_SLOT: UsageSlot = { settle(): void {}, ambiguous(): void {} };

  function holdsPlace(messageId: string): boolean {
    return !blocked() && counted.has(digestOf(messageId));
  }

  function begin(tenantId: string, messageId?: string): UsageSlot | undefined {
    // Unknown usage: no place can be promised, so the send must not go ahead.
    if (blocked()) {
      return undefined;
    }
    const digest = messageId === undefined ? undefined : digestOf(messageId);
    if (digest !== undefined && counted.has(digest)) {
      return HELD_PLACE_SLOT;
    }
    const entry: InflightEntry =
      digest === undefined ? { tenant: tenantId } : { tenant: tenantId, digest };
    inflight.add(entry);
    pending.set(tenantId, (pending.get(tenantId) ?? 0) + 1);
    pendingTotal += 1;
    // Written ahead of the send: a crash from here on leaves the place in the
    // file, and the next start counts it. A write that fails gives it back.
    persist();
    if (unpersisted) {
      unreserve(tenantId, entry);
      return undefined;
    }
    let settled = false;
    // Ends the reservation; false when it had already ended.
    function release(): boolean {
      if (settled) {
        return false;
      }
      settled = true;
      unreserve(tenantId, entry);
      roll();
      return true;
    }
    return {
      settle(accepted: boolean): void {
        if (!release()) {
          return;
        }
        // Already counted at an earlier ambiguous end: one message, one count.
        // Either way the one save also drops the place from the in-flight list.
        if (!accepted || (digest !== undefined && counted.has(digest))) {
          persist();
          return;
        }
        accept(tenantId);
      },
      ambiguous(): void {
        if (!release()) {
          return;
        }
        if (digest !== undefined) {
          if (counted.has(digest)) {
            persist();
            return;
          }
          counted.add(digest);
        }
        accept(tenantId);
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
      vanished,
    };
  }

  load();
  roll();

  return {
    allowanceReached,
    accountCapReached,
    begin,
    holdsPlace,
    tenantLatchState,
    accountState,
    reasons: () => ({ ...reasonCounts }),
  };
}
