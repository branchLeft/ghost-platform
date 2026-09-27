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
    verify: vi.fn(async () => ok()),
    revertTraffic: vi.fn(async () => ok()),
    stopColour: vi.fn(async () => undefined),
    page: vi.fn(async () => undefined),
    ...overrides,
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
  it.each(['done', 'closed', 'backup-failed', 'cancelled', 'failed-unsafe'] as const)(
    'skips a tenant already settled in %s -- no side effect called',
    async (state) => {
      const deps = fakeDeps();
      const store = memoryStore([record(state)]);

      const recovered = await recoverPersistedTenants(store, createApplyLock(), () => deps);

      expect(recovered).toEqual([]);
      expect(deps.apply).not.toHaveBeenCalled();
      expect(deps.revertTraffic).not.toHaveBeenCalled();
    }
  );

  it.each(['pending', 'backing-up', 'backed-up'] as const)(
    'recovers a tenant persisted in %s as cancelled, never touching backup or apply',
    async (state) => {
      const deps = fakeDeps();
      const store = memoryStore([record(state)]);

      const [recovered] = await recoverPersistedTenants(store, createApplyLock(), () => deps);

      expect(recovered!.finalState).toBe('cancelled');
      expect(deps.backup).not.toHaveBeenCalled();
      expect(deps.apply).not.toHaveBeenCalled();
    }
  );

  it('recovers a tenant persisted in applying by verifying it, never calling apply again', async () => {
    const deps = fakeDeps();
    const store = memoryStore([record('applying')]);

    const [recovered] = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.verify).toHaveBeenCalledTimes(1);
    expect(recovered!.finalState).toBe('done');
  });

  it('recovers a tenant persisted in applying to reverted when the outcome verifies unhealthy -- still never re-applying', async () => {
    const deps = fakeDeps({
      verify: vi.fn(async () => ({ ok: false, reason: 'unhealthy after crash' })),
    });
    const store = memoryStore([record('applying')]);

    const [recovered] = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
    expect(recovered!.finalState).toBe('reverted');
  });

  it('recovers a tenant persisted in applying to failed-unsafe when the outcome cannot even be verified', async () => {
    const deps = fakeDeps({
      verify: vi.fn(async () => {
        throw new Error('health endpoint unreachable');
      }),
    });
    const store = memoryStore([record('applying')]);

    const [recovered] = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.page).toHaveBeenCalledTimes(1);
    expect(recovered!.finalState).toBe('failed-unsafe');
  });

  it.each(['verifying', 'reverting'] as const)(
    'recovers a tenant persisted in %s by reverting',
    async (state) => {
      const deps = fakeDeps();
      const store = memoryStore([record(state)]);

      const [recovered] = await recoverPersistedTenants(store, createApplyLock(), () => deps);

      expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
      expect(recovered!.finalState).toBe('reverted');
    }
  );

  it('recovers a tenant persisted in reverted by retrying the new-colour teardown, never re-reverting', async () => {
    const deps = fakeDeps();
    const store = memoryStore([record('reverted')]);

    const [recovered] = await recoverPersistedTenants(store, createApplyLock(), () => deps);

    expect(deps.stopColour).toHaveBeenCalledTimes(1);
    expect(deps.stopColour).toHaveBeenCalledWith('new');
    expect(deps.revertTraffic).not.toHaveBeenCalled();
    expect(recovered!.finalState).toBe('reverted');
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

    const recovered = await recoverPersistedTenants(store, createApplyLock(), build);

    expect(recovered.map((r) => r.tenantId).sort()).toEqual(['t1', 't2']);
    expect(depsByTenant.get('t1')!.apply).not.toHaveBeenCalled();
    expect(depsByTenant.get('t2')!.backup).not.toHaveBeenCalled();
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
      persist: (state) =>
        store.save({
          tenantId: 'tenant-a',
          state,
          pageSent: false,
          updatedAt: new Date().toISOString(),
        }),
    });
    const crashedMachine = new BumpStateMachine(crashedDeps, lock);
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
    // the same store off disk.
    const restartedDeps = fakeDeps();
    const recovered = await recoverPersistedTenants(store, createApplyLock(), () => restartedDeps);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.tenantId).toBe('tenant-a');
    expect(restartedDeps.apply).not.toHaveBeenCalled();
    expect(restartedDeps.verify).toHaveBeenCalledTimes(1);
    expect(recovered[0]!.finalState).toBe('done');

    // Close off the abandoned original promise so the test process itself
    // doesn't leak a dangling handler.
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
      persist: (state) =>
        store.save({
          tenantId: 'tenant-b',
          state,
          pageSent: false,
          updatedAt: new Date().toISOString(),
        }),
    });
    const crashedMachine = new BumpStateMachine(crashedDeps, lock);
    const abandonedRun = crashedMachine.run();

    await waitForState(store, 'tenant-b', 'backing-up');

    const restartedDeps = fakeDeps();
    const recovered = await recoverPersistedTenants(store, createApplyLock(), () => restartedDeps);

    expect(recovered[0]!.finalState).toBe('cancelled');
    expect(restartedDeps.backup).not.toHaveBeenCalled();
    expect(restartedDeps.apply).not.toHaveBeenCalled();

    releaseBackup({ ok: true });
    await abandonedRun;
  });
});
