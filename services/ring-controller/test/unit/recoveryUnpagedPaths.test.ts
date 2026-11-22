/**
 * Two paths in the start-up recovery sweep that used to leave a record
 * needing a page with none sent:
 *
 *  1. a `stopColour()` that THROWS (rather than missing its limit) while
 *     recovering a `reverted` or `closing` record, and
 *  2. a failed save inside `failUnsafe`, which stopped before the page.
 *
 * Each is paired with a sabotage of the real source that puts the old
 * behaviour back, so the test is red without the fix and green with it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as real from '../../src/index.js';
import type {
  BumpDependencies,
  BumpState,
  PersistedTenantState,
  RecoverySweepResult,
} from '../../src/index.js';
import { memoryStore } from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = Pick<typeof real, 'recoverPersistedTenants' | 'createApplyLock'>;

afterAll(() => {
  cleanupSabotageTmp();
});

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

function sweep(
  mod: Module,
  store: real.TenantStateStore,
  tenants: Record<string, Tenant>
): Promise<RecoverySweepResult> {
  return mod.recoverPersistedTenants(
    store,
    mod.createApplyLock(),
    (tenantId) => (tenants[tenantId] as Tenant).deps
  );
}

const sabotaged = (mutation: Mutation): Promise<Module> =>
  importSabotaged<Module>('index.ts', [mutation]);

/** The old rule: only a `stopColour()` that missed its limit was paged for. */
const ONLY_TIMEOUTS_PAGED: Mutation = {
  file: 'recovery.ts',
  find: 'teardown === undefined || teardown.error !== error',
  replace: "!(error instanceof Error && error.name === 'DeadlineExceededError')",
};

/** The old rule: a failed save inside `failUnsafe` ended it before the page. */
const SAVE_FAILURE_SKIPS_PAGE: Mutation = {
  file: 'bumpStateMachine.ts',
  find: '    } catch (error) {\n      saveFailure = { error };\n    }\n    if (!this.pageSent) {',
  replace: '    } catch (error) {\n      throw error;\n    }\n    if (!this.pageSent) {',
};

const SAVE_DOWN = new Error('disk full');

/** A throwing teardown for the first record, then a failed-unsafe record still owed its page. */
async function throwingStop(mod: Module, state: 'reverted' | 'closing') {
  const store = memoryStore([
    record('tenant-a', state),
    record('tenant-b', 'failed-unsafe', { reason: 'earlier failure' }),
  ]);
  const boom = new Error('host refused the stop');
  const a = tenant(store, 'tenant-a', {
    stopColour: async () => {
      throw boom;
    },
  });
  const b = tenant(store, 'tenant-b');
  const result = await sweep(mod, store, { 'tenant-a': a, 'tenant-b': b });
  return { a, b, boom, result, store };
}

/** A revert that cannot run fails the record unsafe; its first `failed-unsafe` save fails (or every one does). */
async function failedSave(mod: Module, { everySave }: { everySave: boolean }) {
  const store = memoryStore([
    record('tenant-a', 'reverting'),
    record('tenant-b', 'failed-unsafe', { reason: 'earlier failure' }),
  ]);
  let failedUnsafeSaves = 0;
  const a = tenant(store, 'tenant-a', {
    revertTraffic: async () => ({ ok: false, reason: 'flag store down' }),
    persist: async (snapshot) => {
      if (snapshot.state === 'failed-unsafe') {
        failedUnsafeSaves += 1;
        if (everySave || failedUnsafeSaves === 1) throw SAVE_DOWN;
      }
      await store.save({ tenantId: 'tenant-a', ...snapshot, updatedAt: 'fixed' });
    },
  });
  const b = tenant(store, 'tenant-b');
  const result = await sweep(mod, store, { 'tenant-a': a, 'tenant-b': b });
  return { a, b, result, store };
}

describe('recovery -- a stopColour() that throws is paged', () => {
  it.each(['reverted', 'closing'] as const)(
    'a throwing teardown of a %s record is paged and reported, and the sweep moves on',
    async (state) => {
      const { a, b, boom, result } = await throwingStop(real, state);

      expect(a.pages).toHaveLength(1);
      expect(a.pages[0]?.reason).toBe(
        `recovery of '${state}' did not finish: host refused the stop`
      );
      expect(a.pages[0]?.dedupeKey).toBe(`bump-tenant-a:${a.pages[0]?.reason}`);
      expect(b.pages).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({ tenantId: 'tenant-a', paged: true });
      expect(result.failed[0]?.error).toBe(boom);
      expect(result.recovered.map((r) => r.tenantId)).toEqual(['tenant-b']);
    }
  );

  it('leaves the record as it was, so the next restart retries the teardown', async () => {
    const { store } = await throwingStop(real, 'closing');
    expect(await store.load('tenant-a')).toMatchObject({ state: 'closing', pageSent: false });
  });

  it('a thrown value that is not an Error is still paged', async () => {
    const store = memoryStore([record('tenant-a', 'reverted')]);
    const a = tenant(store, 'tenant-a', {
      stopColour: () => Promise.reject('plain string'),
    });
    const result = await sweep(real, store, { 'tenant-a': a });
    expect(a.pages[0]?.reason).toBe("recovery of 'reverted' did not finish: plain string");
    expect(result.failed[0]).toMatchObject({ paged: true });
  });

  it('only a teardown is paged for: a failed save after a good teardown is not', async () => {
    const store = memoryStore([record('tenant-a', 'closing')]);
    const a = tenant(store, 'tenant-a', {
      persist: async () => {
        throw SAVE_DOWN;
      },
    });
    const result = await sweep(real, store, { 'tenant-a': a });
    expect(a.pages).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      tenantId: 'tenant-a',
      paged: false,
      error: SAVE_DOWN,
    });
  });

  it('a page that itself throws is reported unpaged, and the sweep still moves on', async () => {
    const store = memoryStore([
      record('tenant-a', 'reverted'),
      record('tenant-b', 'failed-unsafe', { reason: 'earlier failure' }),
    ]);
    const a = tenant(store, 'tenant-a', {
      stopColour: async () => {
        throw new Error('host refused the stop');
      },
      page: async () => {
        throw new Error('pager down');
      },
    });
    const b = tenant(store, 'tenant-b');
    const result = await sweep(real, store, { 'tenant-a': a, 'tenant-b': b });
    expect(result.failed[0]).toMatchObject({ tenantId: 'tenant-a', paged: false });
    expect(b.pages).toHaveLength(1);
  });

  it('sabotage: with only a missed limit paged for, a throwing teardown is never paged', async () => {
    const mod = await sabotaged(ONLY_TIMEOUTS_PAGED);
    const old = await throwingStop(mod, 'reverted');
    expect(old.a.pages).toEqual([]);
    expect(old.result.failed[0]).toMatchObject({ tenantId: 'tenant-a', paged: false });
    expect((await throwingStop(real, 'reverted')).a.pages).toHaveLength(1);
  });
});

describe('recovery -- a failed save inside failUnsafe still pages', () => {
  it('a first failed-unsafe save that fails: the page goes out and the second save records it', async () => {
    const { a, b, result, store } = await failedSave(real, { everySave: false });

    expect(a.pages).toHaveLength(1);
    expect(a.pages[0]?.reason).toBe('flag store down');
    expect(await store.load('tenant-a')).toMatchObject({ state: 'failed-unsafe', pageSent: true });
    expect(b.pages).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(result.recovered.map((r) => r.tenantId)).toEqual(['tenant-a', 'tenant-b']);
  });

  it('every save failing: the page still goes out, the failure is reported as paged, and the sweep moves on', async () => {
    const { a, b, result, store } = await failedSave(real, { everySave: true });

    expect(a.pages).toHaveLength(1);
    expect(a.pages[0]?.reason).toBe('flag store down');
    expect(a.pages[0]?.dedupeKey).toBe('bump-tenant-a:flag store down');
    expect(await store.load('tenant-a')).toMatchObject({ state: 'reverting' });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ tenantId: 'tenant-a', paged: true, error: SAVE_DOWN });
    expect(b.pages).toHaveLength(1);
    expect(result.recovered.map((r) => r.tenantId)).toEqual(['tenant-b']);
  });

  it('a page that throws after a failed save is the failure reported, unpaged', async () => {
    const store = memoryStore([record('tenant-a', 'reverting')]);
    const pagerDown = new Error('pager down');
    const a = tenant(store, 'tenant-a', {
      revertTraffic: async () => ({ ok: false, reason: 'flag store down' }),
      persist: async (snapshot) => {
        if (snapshot.state === 'failed-unsafe') throw SAVE_DOWN;
        await store.save({ tenantId: 'tenant-a', ...snapshot, updatedAt: 'fixed' });
      },
      page: async () => {
        throw pagerDown;
      },
    });
    const result = await sweep(real, store, { 'tenant-a': a });
    expect(result.failed[0]).toMatchObject({
      tenantId: 'tenant-a',
      paged: false,
      error: pagerDown,
    });
  });

  it('sabotage: with a failed save ending failUnsafe early, the record is never paged', async () => {
    const mod = await sabotaged(SAVE_FAILURE_SKIPS_PAGE);
    const old = await failedSave(mod, { everySave: true });
    expect(old.a.pages).toEqual([]);
    expect(old.result.failed[0]).toMatchObject({ tenantId: 'tenant-a', paged: false });
    expect((await failedSave(real, { everySave: true })).a.pages).toHaveLength(1);
  });
});
