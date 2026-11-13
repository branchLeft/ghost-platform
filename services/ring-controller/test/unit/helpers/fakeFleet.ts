import {
  BumpStateMachine,
  type BumpDependencies,
  type BumpState,
} from '../../../src/bumpStateMachine.js';
import { createApplyLock } from '../../../src/applyLock.js';
import type { CallDeadlines } from '../../../src/deadlines.js';
import type { GateReport } from '../../../src/gates.js';
import type { PromotionRecord } from '../../../src/promotionChainLog.js';
import type { RingBakeConfig, RingName } from '../../../src/rings.js';
import type {
  Health,
  Held,
  Release,
  RingControllerDependencies,
  RingMember,
} from '../../../src/ringController.js';

export const DIGEST = 'sha256:release-under-test';
export const OLD_DIGEST = 'sha256:the-previous-release';

export const RELEASE: Release = { digest: DIGEST, version: '1.2.3', route: 'fast-path' };

/** An environment with no model credential and no PATH to search. */
export const CLEAN_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({});

export const DEFAULT_MEMBERS: Record<RingName, RingMember[]> = {
  'slot-0': [{ tenantId: 'canary-mysql', engine: 'mysql' }],
  demos: [{ tenantId: 'demo-1', engine: 'sqlite' }],
  entry: [
    { tenantId: 'entry-1', engine: 'sqlite' },
    { tenantId: 'entry-2', engine: 'sqlite' },
  ],
  professional: [
    { tenantId: 'pro-1', engine: 'sqlite' },
    { tenantId: 'pro-2', engine: 'sqlite' },
  ],
};

export const BAKE_MS = 60_000;
export const POLL_MS = 10_000;

export function bakeConfig(
  overrides: Partial<Record<RingName, { bakeMs: number; pollMs?: number }>> = {}
): RingBakeConfig {
  const base = { bakeMs: BAKE_MS, pollMs: POLL_MS };
  return {
    'slot-0': overrides['slot-0'] ?? base,
    demos: overrides.demos ?? base,
    entry: overrides.entry ?? base,
    professional: overrides.professional ?? base,
  };
}

export interface TenantBehaviour {
  applyOk?: boolean;
  /** Milliseconds the fake clock moves while this tenant's apply runs. */
  applyTakesMs?: number;
  /**
   * Holds one step open on a real (fakeable) timer: `ms` milliseconds, or
   * forever when `ms` is absent. A hung host, not a slow fake clock.
   */
  stall?: { step: 'backup' | 'apply'; ms?: number };
}

export interface FleetOptions {
  members?: Partial<Record<RingName, RingMember[]>>;
  gates?: (digest: string) => GateReport | Promise<GateReport>;
  tenants?: Record<string, TenantBehaviour>;
  health?: (tenantId: string, nowMs: number) => Health | Promise<Health>;
  reportedErrors?: (
    tenantId: string,
    sinceMs: number,
    nowMs: number
  ) => readonly string[] | Promise<readonly string[]>;
  listMembers?: (ring: RingName) => Promise<readonly RingMember[]>;
  runGatesThrows?: boolean;
  /** Replaces the default recorder, which accepts every record. */
  recordPromotion?: (record: PromotionRecord) => Promise<void>;
  /** Passed through as `deps.deadlines`; absent means the controller's defaults. */
  deadlines?: Partial<CallDeadlines>;
}

/** Counts how many `run()` calls are in flight at once. */
class CountingMachine extends BumpStateMachine {
  constructor(
    deps: BumpDependencies,
    lock: ReturnType<typeof createApplyLock>,
    bumpId: string,
    private readonly counter: { inFlight: number; highWater: number }
  ) {
    super(deps, lock, { bumpId });
  }

  override async run(): Promise<BumpState> {
    this.counter.inFlight += 1;
    this.counter.highWater = Math.max(this.counter.highWater, this.counter.inFlight);
    try {
      return await super.run();
    } finally {
      this.counter.inFlight -= 1;
    }
  }
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const stallFor = (ms: number | undefined): Promise<void> =>
  ms === undefined
    ? new Promise<void>(() => undefined)
    : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A whole fleet of fakes with a fake clock. Real `BumpStateMachine`s over
 * fake hosts, all sharing ONE `ApplyLock`, exactly as a caller must wire them.
 */
export function makeFleet(options: FleetOptions = {}) {
  let nowMs = 1_000_000;
  const members: Record<RingName, RingMember[]> = { ...DEFAULT_MEMBERS, ...options.members };
  const ringOf = new Map<string, RingName>();
  for (const [ring, list] of Object.entries(members) as [RingName, RingMember[]][]) {
    for (const member of list) ringOf.set(member.tenantId, ring);
  }

  const sleeps: number[] = [];
  const events: string[] = [];
  const holds: Held[] = [];
  const records: PromotionRecord[] = [];
  const pages: string[] = [];
  const counter = { inFlight: 0, highWater: 0 };
  const calls = { newBump: 0, runGates: 0, health: 0, reportedErrors: 0 };
  const machines = new Map<string, BumpStateMachine>();
  /** Clock time at which each tenant's old colour was stopped. */
  const closedAt = new Map<string, number>();
  const doneAt = new Map<string, number>();
  const lock = createApplyLock();

  const clock = {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  };

  function depsFor(tenantId: string): BumpDependencies {
    const behaviour = options.tenants?.[tenantId] ?? {};
    return {
      backup: async () => {
        await macrotask();
        if (behaviour.stall?.step === 'backup') await stallFor(behaviour.stall.ms);
        return { ok: true };
      },
      apply: async () => {
        events.push(`apply:${tenantId}`);
        nowMs += behaviour.applyTakesMs ?? 0;
        if (behaviour.stall?.step === 'apply') await stallFor(behaviour.stall.ms);
        return behaviour.applyOk === false
          ? { ok: false, reason: 'migration failed' }
          : { ok: true };
      },
      awaitApplySettled: async () => ({ ok: true }),
      verify: async () => {
        doneAt.set(tenantId, nowMs);
        return { ok: true };
      },
      revertTraffic: async () => {
        events.push(`revert:${tenantId}`);
        return { ok: true };
      },
      stopColour: async (which) => {
        events.push(`stop-${which}:${tenantId}`);
        if (which === 'old') closedAt.set(tenantId, nowMs);
      },
      page: async (reason) => {
        pages.push(`${tenantId}:${reason}`);
      },
    };
  }

  const deps: RingControllerDependencies = {
    listMembers: async (ring) => {
      if (options.listMembers) return options.listMembers(ring);
      return members[ring];
    },
    runGates: async (digest) => {
      calls.runGates += 1;
      if (options.runGatesThrows) throw new Error('gate host unreachable');
      if (options.gates) return options.gates(digest);
      return {
        digest,
        results: [
          { name: 'smoke', ok: true },
          { name: 'migrations', ok: true },
        ],
      };
    },
    newBump: (member) => {
      calls.newBump += 1;
      const machine = new CountingMachine(
        depsFor(member.tenantId),
        lock,
        `bump-${member.tenantId}`,
        counter
      );
      machines.set(member.tenantId, machine);
      return machine;
    },
    health: async (tenantId) => {
      calls.health += 1;
      if (options.health) return options.health(tenantId, nowMs);
      return { healthy: true, reportedDigest: DIGEST };
    },
    reportedErrors: async (tenantId, sinceMs) => {
      calls.reportedErrors += 1;
      if (options.reportedErrors) return options.reportedErrors(tenantId, sinceMs, nowMs);
      return [];
    },
    recordPromotion: async (record) => {
      if (options.recordPromotion) await options.recordPromotion(record);
      events.push(`record:${record.slot}`);
      records.push(record);
    },
    hold: async (held) => {
      holds.push(held);
    },
    clock,
    ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
  };

  return {
    deps,
    clock,
    sleeps,
    events,
    holds,
    records,
    pages,
    counter,
    calls,
    machines,
    closedAt,
    doneAt,
    members,
    ringOf,
    /** Tenants in the order their bump started (their `apply` ran). */
    bumpOrder: () =>
      events.filter((e) => e.startsWith('apply:')).map((e) => e.slice('apply:'.length)),
    ringsInBumpOrder: () => {
      const rings: RingName[] = [];
      for (const tenant of events.filter((e) => e.startsWith('apply:')).map((e) => e.slice(6))) {
        const ring = ringOf.get(tenant) as RingName;
        if (rings[rings.length - 1] !== ring) rings.push(ring);
      }
      return rings;
    },
    stoppedOld: () => events.filter((e) => e.startsWith('stop-old:')).map((e) => e.slice(9)),
    nowMs: () => nowMs,
  };
}

export type Fleet = ReturnType<typeof makeFleet>;
