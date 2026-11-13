/**
 * The start-up recovery sweep bounds every call it makes that the machine
 * does not already bound: `revertTraffic()`, `stopColour()` and `page()`.
 * A call that misses its limit is read as a throw, so one hung record never
 * stalls the records after it, and a timed-out record is paged. Each limit
 * is pinned by exact time (not yet settled one millisecond early, settled at
 * the limit) and paired with a one-line sabotage of the real source.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as real from '../../src/index.js';
import type {
  BumpDependencies,
  BumpState,
  PersistedTenantState,
  RecoveryDeadlines,
  RecoverySweepResult,
} from '../../src/index.js';
import { memoryStore } from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = Pick<typeof real, 'recoverPersistedTenants' | 'createApplyLock'>;

// Three different values, so a limit read from the wrong field is caught.
const LIMITS: RecoveryDeadlines = { revertTrafficMs: 1_000, stopColourMs: 2_000, pageMs: 3_000 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  cleanupSabotageTmp();
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function record(
  tenantId: string,
  state: BumpState,
  overrides: Partial<PersistedTenantState> = {}
): PersistedTenantState {
  return {
    tenantId,
    state,
    pageSent: false,
    updatedAt: 'fixed',
    bumpId: `bump-${tenantId}`,
    ...overrides,
  };
}

interface Tenant {
  deps: BumpDependencies;
  pages: { reason: string; dedupeKey: string }[];
}

function tenant(
  store: real.TenantStateStore,
  tenantId: string,
  overrides: Partial<BumpDependencies> = {}
): Tenant {
  const pages: Tenant['pages'] = [];
  const deps: BumpDependencies = {
    backup: async () => ({ ok: true }),
    apply: async () => ({ ok: true }),
    awaitApplySettled: async () => ({ ok: true }),
    verify: async () => ({ ok: true }),
    revertTraffic: async () => ({ ok: true }),
    stopColour: async () => undefined,
    page: async (reason, dedupeKey) => {
      pages.push({ reason, dedupeKey });
    },
    persist: async (snapshot) => {
      await store.save({ tenantId, ...snapshot, updatedAt: 'fixed' });
    },
    ...overrides,
  };
  return { deps, pages };
}

interface Sweep {
  /** Whether the sweep had settled `afterMs` of fake time into it. */
  settledAt(afterMs: number): Promise<boolean>;
  result(): RecoverySweepResult;
}

/** Starts a sweep and lets fake time be advanced in steps, reporting whether it has settled. */
function startSweep(
  mod: Module,
  store: real.TenantStateStore,
  tenants: Record<string, Tenant>
): Sweep {
  let settled = false;
  let result: RecoverySweepResult | undefined;
  void mod
    .recoverPersistedTenants(
      store,
      mod.createApplyLock(),
      (tenantId) => (tenants[tenantId] as Tenant).deps,
      LIMITS
    )
    .then((value) => {
      settled = true;
      result = value;
    });
  let elapsed = 0;
  return {
    async settledAt(afterMs) {
      await vi.advanceTimersByTimeAsync(afterMs - elapsed);
      elapsed = afterMs;
      return settled;
    },
    result() {
      if (result === undefined) throw new Error('the sweep has not settled');
      return result;
    },
  };
}

const sabotaged = (mutation: Mutation): Promise<Module> =>
  importSabotaged<Module>('index.ts', [mutation]);

const REVERT_LIMIT: Mutation = {
  file: 'recovery.ts',
  find: "withDeadline(deps.revertTraffic(), limits.revertTrafficMs, 'revertTraffic()')",
  replace: 'deps.revertTraffic()',
};
const STOP_LIMIT: Mutation = {
  file: 'recovery.ts',
  find: "withDeadline(deps.stopColour(which), limits.stopColourMs, 'stopColour()')",
  replace: 'deps.stopColour(which)',
};
const PAGE_LIMIT: Mutation = {
  file: 'recovery.ts',
  find: "withDeadline(deps.page(reason, dedupeKey), limits.pageMs, 'page()')",
  replace: 'deps.page(reason, dedupeKey)',
};

/** A hung revert for the first record, then a failed-unsafe record still owed its page. */
async function hungRevert(mod: Module) {
  const store = memoryStore([
    record('tenant-a', 'reverting'),
    record('tenant-b', 'failed-unsafe', { reason: 'earlier failure' }),
  ]);
  const a = tenant(store, 'tenant-a', { revertTraffic: () => never() });
  const b = tenant(store, 'tenant-b');
  const sweep = startSweep(mod, store, { 'tenant-a': a, 'tenant-b': b });
  const early = await sweep.settledAt(LIMITS.revertTrafficMs - 1);
  const atLimit = await sweep.settledAt(LIMITS.revertTrafficMs + 1);
  return { early, atLimit, a, b, store, sweep };
}

/** A hung teardown for the first record, then a failed-unsafe record still owed its page. */
async function hungStop(mod: Module, state: 'reverted' | 'closing') {
  const store = memoryStore([
    record('tenant-a', state),
    record('tenant-b', 'failed-unsafe', { reason: 'earlier failure' }),
  ]);
  const a = tenant(store, 'tenant-a', { stopColour: () => never() });
  const b = tenant(store, 'tenant-b');
  const sweep = startSweep(mod, store, { 'tenant-a': a, 'tenant-b': b });
  const early = await sweep.settledAt(LIMITS.stopColourMs - 1);
  const atLimit = await sweep.settledAt(LIMITS.stopColourMs + 1);
  return { early, atLimit, a, b, store, sweep };
}

/** A hung page for the first record, then a failed-unsafe record still owed its page. */
async function hungPage(mod: Module) {
  const store = memoryStore([
    record('tenant-a', 'failed-unsafe', { reason: 'first failure' }),
    record('tenant-b', 'failed-unsafe', { reason: 'second failure' }),
  ]);
  const a = tenant(store, 'tenant-a', { page: () => never() });
  const b = tenant(store, 'tenant-b');
  const sweep = startSweep(mod, store, { 'tenant-a': a, 'tenant-b': b });
  const early = await sweep.settledAt(LIMITS.pageMs - 1);
  const atLimit = await sweep.settledAt(LIMITS.pageMs + 1);
  return { early, atLimit, a, b, store, sweep };
}

describe('recovery -- revertTraffic() has a per-record limit', () => {
  it('a hung revert fails that record to unsafe, pages it, and the sweep moves on', async () => {
    const { early, atLimit, a, b, store, sweep } = await hungRevert(real);

    expect(early).toBe(false);
    expect(atLimit).toBe(true);
    expect(a.pages).toHaveLength(1);
    expect(a.pages[0]?.reason).toBe('revertTraffic() did not answer within 1000ms');
    expect(a.pages[0]?.dedupeKey).toBe(
      'bump-tenant-a:revertTraffic() did not answer within 1000ms'
    );
    expect(await store.load('tenant-a')).toMatchObject({ state: 'failed-unsafe', pageSent: true });
    expect(b.pages).toHaveLength(1);
    expect(sweep.result().recovered.map((r) => r.tenantId)).toEqual(['tenant-a', 'tenant-b']);
    expect(sweep.result().failed).toEqual([]);
  });

  it('without the limit, a hung revert stalls every record after it', async () => {
    const mod = await sabotaged(REVERT_LIMIT);
    const sabotagedRun = await hungRevert(mod);
    expect(sabotagedRun.atLimit).toBe(false);
    expect(sabotagedRun.b.pages).toHaveLength(0);
    expect((await hungRevert(real)).atLimit).toBe(true);
  });
});

describe('recovery -- stopColour() has a per-record limit', () => {
  it.each(['reverted', 'closing'] as const)(
    'a hung teardown of a %s record is paged and reported, and the sweep moves on',
    async (state) => {
      const { early, atLimit, a, b, sweep } = await hungStop(real, state);

      expect(early).toBe(false);
      expect(atLimit).toBe(true);
      expect(a.pages).toHaveLength(1);
      expect(a.pages[0]?.reason).toBe(
        `recovery of '${state}' did not finish: stopColour() did not answer within 2000ms`
      );
      expect(a.pages[0]?.dedupeKey).toBe(`bump-tenant-a:${a.pages[0]?.reason}`);
      expect(b.pages).toHaveLength(1);
      const { failed } = sweep.result();
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ tenantId: 'tenant-a', paged: true });
      expect(failed[0]?.error).toBeInstanceOf(real.DeadlineExceededError);
    }
  );

  it('a teardown that answers in time is neither paged nor reported', async () => {
    const store = memoryStore([record('tenant-a', 'reverted')]);
    const a = tenant(store, 'tenant-a');
    const sweep = startSweep(real, store, { 'tenant-a': a });
    expect(await sweep.settledAt(1)).toBe(true);
    expect(a.pages).toEqual([]);
    expect(sweep.result().failed).toEqual([]);
  });

  it('without the limit, a hung teardown stalls every record after it', async () => {
    const mod = await sabotaged(STOP_LIMIT);
    const sabotagedRun = await hungStop(mod, 'reverted');
    expect(sabotagedRun.atLimit).toBe(false);
    expect(sabotagedRun.b.pages).toHaveLength(0);
    expect((await hungStop(real, 'reverted')).atLimit).toBe(true);
  });
});

describe('recovery -- page() has a per-record limit', () => {
  it('a hung page is reported, the record stays owed its page, and the sweep moves on', async () => {
    const { early, atLimit, b, store, sweep } = await hungPage(real);

    expect(early).toBe(false);
    expect(atLimit).toBe(true);
    expect(b.pages).toHaveLength(1);
    expect(await store.load('tenant-a')).toMatchObject({ state: 'failed-unsafe', pageSent: false });
    const { failed } = sweep.result();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ tenantId: 'tenant-a', paged: false });
    expect((failed[0]?.error as Error).message).toBe('page() did not answer within 3000ms');
  });

  it('without the limit, a hung page stalls every record after it', async () => {
    const mod = await sabotaged(PAGE_LIMIT);
    const sabotagedRun = await hungPage(mod);
    expect(sabotagedRun.atLimit).toBe(false);
    expect(sabotagedRun.b.pages).toHaveLength(0);
    expect((await hungPage(real)).atLimit).toBe(true);
  });
});

describe('recovery -- the limits themselves', () => {
  it('a limit that is not a finite number above zero is refused before any record is touched', async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const store = memoryStore([record('tenant-a', 'reverted')]);
      const list = vi.spyOn(store, 'list');
      await expect(
        real.recoverPersistedTenants(store, real.createApplyLock(), () => tenant(store, 'x').deps, {
          pageMs: bad,
        })
      ).rejects.toThrow(RangeError);
      expect(list).not.toHaveBeenCalled();
    }
  });

  it('a limit left out takes its default', () => {
    expect(real.resolveRecoveryDeadlines({ pageMs: 5 })).toEqual({
      ...real.DEFAULT_RECOVERY_DEADLINES,
      pageMs: 5,
    });
  });
});
