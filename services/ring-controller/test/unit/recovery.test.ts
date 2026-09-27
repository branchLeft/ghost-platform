import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import { createApplyLock } from '../../src/applyLock.js';
import {
  BumpStateMachine,
  type BumpDependencies,
  type BumpState,
  type StepResult,
} from '../../src/bumpStateMachine.js';
import { recoverPersistedTenants } from '../../src/recovery.js';
import {
  createFileTenantStateStore,
  type PersistedTenantState,
  type TenantStateStore,
} from '../../src/tenantStateStore.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('ring-controller-recovery-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function ok(): StepResult {
  return { ok: true };
}

function fakeDeps(overrides: Partial<BumpDependencies> = {}): BumpDependencies {
  return {
    backup: vi.fn(async () => ok()),
    apply: vi.fn(async () => ok()),
    awaitApplySettled: vi.fn(async () => ok()),
    verify: vi.fn(async () => ok()),
    revertTraffic: vi.fn(async () => ok()),
    stopColour: vi.fn(async () => undefined),
    page: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** Persists straight into a store, matching the shape a real `persist` wiring would use. */
function persistTo(store: TenantStateStore, tenantId: string): BumpDependencies['persist'] {
  return async (snapshot) => {
    await store.save({ tenantId, ...snapshot, updatedAt: new Date().toISOString() });
  };
}

/** An in-memory store for recovery-table tests that don't need real disk I/O. */
function memoryStore(records: PersistedTenantState[]): TenantStateStore {
  const map = new Map(records.map((r) => [r.tenantId, r]));
  return {
    async save(r) {
      map.set(r.tenantId, r);
    },
    async load(id) {
      return map.get(id);
    },
    async remove(id) {
      map.delete(id);
    },
    async list() {
      return [...map.values()];
    },
  };
}

function record(
  state: BumpState,
  overrides: Partial<PersistedTenantState> = {}
): PersistedTenantState {
  return {
    tenantId: 'tenant-a',
    state,
    pageSent: false,
    updatedAt: '2026-09-27T00:00:00.000Z',
    bumpId: 'test-bump',
    ...overrides,
  };
}

async function waitForState(
  store: TenantStateStore,
  tenantId: string,
  state: BumpState,
  timeoutMs = 2000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const found = await store.load(tenantId);
    if (found?.state === state) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for ${tenantId} to reach '${state}', last saw '${found?.state}'`
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('recoverPersistedTenants -- the recovery table', () => {
  it.each(['closed', 'backup-failed', 'cancelled'] as const)(
    'skips a tenant already settled in %s -- no side effect called',
    async (state) => {
      const deps = fakeDeps();
      const store = memoryStore([record(state)]);

      const { recovered } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

      expect(recovered).toEqual([]);
      expect(deps.apply).not.toHaveBeenCalled();
      expect(deps.revertTraffic).not.toHaveBeenCalled();
    }
  );

  it('skips a failed-unsafe tenant whose page already went out', async () => {
    const deps = fakeDeps();
    const store = memoryStore([record('failed-unsafe', { pageSent: true })]);

    const { recovered } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(recovered).toEqual([]);
    expect(deps.page).not.toHaveBeenCalled();
  });

  it('rehydrates a done tenant with no action, so a later closeBakeWindow/abortAfterDone has something to act on', async () => {
    const deps = fakeDeps();
    const store = memoryStore([record('done')]);

    const {
      recovered: [recovered],
    } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(recovered!.finalState).toBe('done');
    expect(deps.stopColour).not.toHaveBeenCalled();
    expect(recovered!.machine.getState()).toBe('done');
    // The rehydrated machine is live and usable, not a dead husk.
    const closed = await recovered!.machine.closeBakeWindow();
    expect(closed).toBe('closed');
  });

  it.each(['pending', 'backing-up', 'backed-up'] as const)(
    'recovers a tenant persisted in %s as cancelled, never touching backup or apply',
    async (state) => {
      const deps = fakeDeps();
      const store = memoryStore([record(state)]);

      const {
        recovered: [recovered],
      } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

      expect(recovered!.finalState).toBe('cancelled');
      expect(deps.backup).not.toHaveBeenCalled();
      expect(deps.apply).not.toHaveBeenCalled();
    }
  );

  it('recovers a tenant persisted in applying by waiting for settlement then verifying, never calling apply again', async () => {
    const deps = fakeDeps();
    const store = memoryStore([record('applying')]);

    const {
      recovered: [recovered],
    } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.awaitApplySettled).toHaveBeenCalledTimes(1);
    expect(deps.verify).toHaveBeenCalledTimes(1);
    expect(recovered!.finalState).toBe('done');
  });

  it('recovers a tenant persisted in applying to failed-unsafe when settlement cannot be confirmed -- never touching verify, revertTraffic or stopColour', async () => {
    const deps = fakeDeps({
      awaitApplySettled: vi.fn(async () => ({ ok: false, reason: 'migrations_lock still held' })),
    });
    const store = memoryStore([record('applying')]);

    const {
      recovered: [recovered],
    } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.revertTraffic).not.toHaveBeenCalled();
    expect(deps.stopColour).not.toHaveBeenCalled();
    expect(deps.page).toHaveBeenCalledWith('migrations_lock still held', expect.any(String));
    expect(recovered!.finalState).toBe('failed-unsafe');
  });

  it('recovers a tenant persisted in applying to reverted when the settled outcome verifies unhealthy -- still never re-applying', async () => {
    const deps = fakeDeps({
      verify: vi.fn(async () => ({ ok: false, reason: 'unhealthy after crash' })),
    });
    const store = memoryStore([record('applying')]);

    const {
      recovered: [recovered],
    } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
    expect(recovered!.finalState).toBe('reverted');
  });

  it.each(['verifying', 'reverting'] as const)(
    'recovers a tenant persisted in %s by reverting',
    async (state) => {
      const deps = fakeDeps();
      const store = memoryStore([record(state)]);

      const {
        recovered: [recovered],
      } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

      expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
      expect(recovered!.finalState).toBe('reverted');
    }
  );

  it('recovers a tenant persisted in reverted by retrying the new-colour teardown, never re-reverting', async () => {
    const deps = fakeDeps();
    const store = memoryStore([record('reverted')]);

    const {
      recovered: [recovered],
    } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.stopColour).toHaveBeenCalledTimes(1);
    expect(deps.stopColour).toHaveBeenCalledWith('new');
    expect(deps.revertTraffic).not.toHaveBeenCalled();
    expect(recovered!.finalState).toBe('reverted');
  });

  it('recovers a tenant persisted in closing by retrying the old-colour teardown and landing on closed', async () => {
    const deps = fakeDeps();
    const store = memoryStore([record('closing')]);

    const {
      recovered: [recovered],
    } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.stopColour).toHaveBeenCalledWith('old');
    expect(recovered!.finalState).toBe('closed');
  });

  it('recovers an unpaged failed-unsafe tenant by paging once and persisting pageSent: true', async () => {
    const store = memoryStore([
      record('failed-unsafe', { pageSent: false, reason: 'unreachable' }),
    ]);
    const deps = fakeDeps({ persist: persistTo(store, 'tenant-a') });

    const {
      recovered: [recovered],
    } = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.page).toHaveBeenCalledTimes(1);
    expect(deps.page).toHaveBeenCalledWith('unreachable', expect.any(String));
    expect(recovered!.finalState).toBe('failed-unsafe');
    expect((await store.load('tenant-a'))?.pageSent).toBe(true);
  });

  it('recovers every non-settled tenant independently, each against its own deps', async () => {
    const store = memoryStore([
      record('applying', { tenantId: 't1' }),
      record('pending', { tenantId: 't2' }),
    ]);
    const depsByTenant = new Map<string, BumpDependencies>();
    const build = (tenantId: string): BumpDependencies => {
      const deps = fakeDeps();
      depsByTenant.set(tenantId, deps);
      return deps;
    };

    const { recovered } = await recoverPersistedTenants(store, createApplyLock(), build);

    expect(recovered.map((r) => r.tenantId).sort()).toEqual(['t1', 't2']);
    expect(depsByTenant.get('t1')!.apply).not.toHaveBeenCalled();
    expect(depsByTenant.get('t2')!.backup).not.toHaveBeenCalled();
  });

  it('one tenant throwing during recovery never stops the sweep -- a later failed-unsafe/pageSent:false tenant is still paged, and the failure is reported, not dropped', async () => {
    const store = memoryStore([
      record('applying', { tenantId: 'throws' }),
      record('failed-unsafe', { tenantId: 'unpaged', reason: 'edge unreachable' }),
    ]);
    const unpagedDeps = fakeDeps();
    const thrown = new Error('could not build deps for this tenant');
    const build = (tenantId: string): BumpDependencies => {
      if (tenantId === 'throws') {
        // Simulates a completely unexpected failure building this
        // tenant's own dependencies -- not something recoverFromApplying
        // itself could have contained, since it happens before any
        // BumpStateMachine method is even called.
        throw thrown;
      }
      return unpagedDeps;
    };
    const loggedErrors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      loggedErrors.push(args);
    });

    const { recovered, failed } = await recoverPersistedTenants(store, createApplyLock(), build);

    expect(recovered.map((r) => r.tenantId)).toEqual(['unpaged']);
    expect(unpagedDeps.page).toHaveBeenCalledTimes(1);
    expect(unpagedDeps.page).toHaveBeenCalledWith('edge unreachable', expect.any(String));
    // The failure itself is neither dropped nor merely logged -- it is a
    // first-class part of the sweep's own result, so a caller can tell
    // "nothing left to recover" from "recovery itself failed" and act
    // on it (page an operator, alert on it, whatever fits).
    expect(failed).toEqual([{ tenantId: 'throws', error: thrown }]);
    expect(loggedErrors).toHaveLength(1);
    expect(String(loggedErrors[0])).toContain('throws');

    consoleError.mockRestore();
  });
});

describe('crash-and-restart -- real file store, real ApplyLock, through the real entry point', () => {
  it('a tenant crashed mid-applying is recovered on restart without ever calling apply() a second time', async () => {
    const dir = await tempDir();
    const store = createFileTenantStateStore(dir);
    const lock = createApplyLock();

    let releaseApply!: (v: StepResult) => void;
    const applyGate = new Promise<StepResult>((resolve) => {
      releaseApply = resolve;
    });

    const crashedDeps = fakeDeps({
      apply: vi.fn(() => applyGate),
      persist: persistTo(store, 'tenant-a'),
    });
    const crashedMachine = new BumpStateMachine(crashedDeps, lock, { bumpId: 'crash-test-bump' });
    const abandonedRun = crashedMachine.run();

    // The process "crashes" here: `applyGate` is never resolved by this
    // side, and `abandonedRun` is never awaited again. Only the durable
    // record on disk survives.
    await waitForState(store, 'tenant-a', 'applying');
    // Margin for the microtask that invokes apply() itself, which runs
    // immediately after the persisted write above resolves.
    await new Promise((r) => setTimeout(r, 20));
    expect(crashedDeps.apply).toHaveBeenCalledTimes(1);

    // A fresh process: new deps, new lock object, same tenant id, reading
    // the same store off disk. This restarted process's own `apply()` is
    // never called; its `awaitApplySettled()` (default: settled ok) is
    // what recovery calls instead.
    const restartedDeps = fakeDeps();
    const { recovered } = await recoverPersistedTenants(
      store,
      createApplyLock(),
      () => restartedDeps
    );

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.tenantId).toBe('tenant-a');
    expect(restartedDeps.apply).not.toHaveBeenCalled();
    expect(restartedDeps.awaitApplySettled).toHaveBeenCalledTimes(1);
    expect(restartedDeps.verify).toHaveBeenCalledTimes(1);
    expect(recovered[0]!.finalState).toBe('done');

    // Close off the abandoned original promise so the test process itself
    // doesn't leak a dangling handler.
    releaseApply({ ok: true });
    await abandonedRun;
  });

  it('a tenant crashed mid-applying, whose migration cannot be confirmed settled on restart, never has stopColour or revertTraffic called', async () => {
    const dir = await tempDir();
    const store = createFileTenantStateStore(dir);
    const lock = createApplyLock();

    let releaseApply!: (v: StepResult) => void;
    const applyGate = new Promise<StepResult>((resolve) => {
      releaseApply = resolve;
    });

    const crashedDeps = fakeDeps({
      apply: vi.fn(() => applyGate),
      persist: persistTo(store, 'tenant-a'),
    });
    const crashedMachine = new BumpStateMachine(crashedDeps, lock, { bumpId: 'crash-test-bump' });
    const abandonedRun = crashedMachine.run();
    await waitForState(store, 'tenant-a', 'applying');

    const restartedDeps = fakeDeps({
      awaitApplySettled: vi.fn(async () => ({ ok: false, reason: 'unknown after crash' })),
    });
    const { recovered } = await recoverPersistedTenants(
      store,
      createApplyLock(),
      () => restartedDeps
    );

    expect(recovered[0]!.finalState).toBe('failed-unsafe');
    expect(restartedDeps.verify).not.toHaveBeenCalled();
    expect(restartedDeps.revertTraffic).not.toHaveBeenCalled();
    expect(restartedDeps.stopColour).not.toHaveBeenCalled();
    expect(restartedDeps.page).toHaveBeenCalledWith('unknown after crash', expect.any(String));

    releaseApply({ ok: true });
    await abandonedRun;
  });

  it('a tenant crashed mid-backing-up is recovered as cancelled, and backup is never retried', async () => {
    const dir = await tempDir();
    const store = createFileTenantStateStore(dir);
    const lock = createApplyLock();

    let releaseBackup!: (v: StepResult) => void;
    const backupGate = new Promise<StepResult>((resolve) => {
      releaseBackup = resolve;
    });

    const crashedDeps = fakeDeps({
      backup: vi.fn(() => backupGate),
      persist: persistTo(store, 'tenant-b'),
    });
    const crashedMachine = new BumpStateMachine(crashedDeps, lock, { bumpId: 'crash-test-bump' });
    const abandonedRun = crashedMachine.run();

    await waitForState(store, 'tenant-b', 'backing-up');

    const restartedDeps = fakeDeps();
    const { recovered } = await recoverPersistedTenants(
      store,
      createApplyLock(),
      () => restartedDeps
    );

    expect(recovered[0]!.finalState).toBe('cancelled');
    expect(restartedDeps.backup).not.toHaveBeenCalled();
    expect(restartedDeps.apply).not.toHaveBeenCalled();

    releaseBackup({ ok: true });
    await abandonedRun;
  });

  it('a tenant that crashes between recording failed-unsafe and paging is still paged on restart', async () => {
    const dir = await tempDir();
    const store = createFileTenantStateStore(dir);
    const lock = createApplyLock();

    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });

    const crashedDeps = fakeDeps({
      verify: vi.fn(async () => ({ ok: false, reason: 'content check failed' })),
      revertTraffic: vi.fn(async () => ({ ok: false, reason: 'edge unreachable' })),
      page: vi.fn(() => pageGate),
      persist: persistTo(store, 'tenant-c'),
    });
    const crashedMachine = new BumpStateMachine(crashedDeps, lock, { bumpId: 'crash-test-bump' });
    const abandonedRun = crashedMachine.run();

    // The state is recorded as failed-unsafe (pageSent: false) strictly
    // before page() is called -- waitForState catches exactly that gap,
    // since page() never resolves on this side.
    await waitForState(store, 'tenant-c', 'failed-unsafe');
    expect((await store.load('tenant-c'))?.pageSent).toBe(false);

    // The restarted process wires persist to the same durable store, same
    // as the live path does -- recovery's own pageSent: true write must
    // reach disk too, not just the in-memory recovered machine.
    const restartedDeps = fakeDeps({ persist: persistTo(store, 'tenant-c') });
    const { recovered } = await recoverPersistedTenants(
      store,
      createApplyLock(),
      () => restartedDeps
    );

    expect(recovered[0]!.finalState).toBe('failed-unsafe');
    expect(restartedDeps.page).toHaveBeenCalledTimes(1);
    expect(restartedDeps.page).toHaveBeenCalledWith('edge unreachable', expect.any(String));
    expect((await store.load('tenant-c'))?.pageSent).toBe(true);

    releasePage();
    await abandonedRun;
  });

  it('a live page and its post-crash recovery page carry the identical dedupe key -- never random, never mismatched', async () => {
    const dir = await tempDir();
    const store = createFileTenantStateStore(dir);
    const lock = createApplyLock();

    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const liveDedupeKeys: string[] = [];

    const crashedDeps = fakeDeps({
      verify: vi.fn(async () => ({ ok: false, reason: 'content check failed' })),
      revertTraffic: vi.fn(async () => ({ ok: false, reason: 'edge unreachable' })),
      page: vi.fn((_reason: string, dedupeKey: string) => {
        liveDedupeKeys.push(dedupeKey);
        return pageGate;
      }),
      persist: persistTo(store, 'tenant-dedupe'),
    });
    const crashedMachine = new BumpStateMachine(crashedDeps, lock, {
      bumpId: 'tenant-dedupe-bump',
    });
    const abandonedRun = crashedMachine.run();

    // The live page is in flight -- pageGate never resolves on this side --
    // when the process "crashes": pageSent is persisted only after page()
    // returns, so the on-disk record still says false.
    await waitForState(store, 'tenant-dedupe', 'failed-unsafe');
    expect((await store.load('tenant-dedupe'))?.pageSent).toBe(false);
    // Margin for the microtask that calls page() itself, which runs
    // immediately after the 'failed-unsafe' persist above resolves.
    await new Promise((r) => setTimeout(r, 20));
    expect(liveDedupeKeys).toHaveLength(1);

    const recoveryDedupeKeys: string[] = [];
    const restartedDeps = fakeDeps({
      page: vi.fn(async (_reason: string, dedupeKey: string) => {
        recoveryDedupeKeys.push(dedupeKey);
      }),
      persist: persistTo(store, 'tenant-dedupe'),
    });
    const { recovered } = await recoverPersistedTenants(
      store,
      createApplyLock(),
      () => restartedDeps
    );

    expect(recovered[0]!.tenantId).toBe('tenant-dedupe');
    expect(recoveryDedupeKeys).toEqual(liveDedupeKeys);
    expect(liveDedupeKeys[0]).toBe('tenant-dedupe-bump:edge unreachable');

    releasePage();
    await abandonedRun;
  });
});
