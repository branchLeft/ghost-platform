/**
 * An abort is honoured in every pre-apply state, is saved before `abort()`
 * settles, reaches the store after any write it interrupted, and a restart
 * never ends an aborted tenant `done`. Each property is paired with a
 * one-line sabotage of the real source that breaks it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as real from '../../src/index.js';
import type { BumpDependencies, BumpState, PersistSnapshot } from '../../src/index.js';
import { memoryStore, stallFor } from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = Pick<
  typeof real,
  'BumpStateMachine' | 'createApplyLock' | 'recoverPersistedTenants' | 'createFileTenantStateStore'
>;

const TENANT = 'tenant-a';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  cleanupSabotageTmp();
});

interface Calls {
  apply: number;
  revert: number;
}

function fakeDeps(calls: Calls, overrides: Partial<BumpDependencies> = {}): BumpDependencies {
  return {
    backup: async () => ({ ok: true }),
    apply: async () => {
      calls.apply += 1;
      return { ok: true };
    },
    awaitApplySettled: async () => ({ ok: true }),
    verify: async () => ({ ok: true }),
    revertTraffic: async () => {
      calls.revert += 1;
      return { ok: true };
    },
    stopColour: async () => undefined,
    page: async () => undefined,
    ...overrides,
  };
}

/** A `persist` that lands in `store` once `delay` (fake ms, or forever) has passed. */
function persistInto(
  store: real.TenantStateStore,
  delay: (snapshot: PersistSnapshot) => number | 'forever' | undefined = () => undefined
): BumpDependencies['persist'] {
  return async (snapshot) => {
    const ms = delay(snapshot);
    if (ms !== undefined) await stallFor(ms === 'forever' ? undefined : ms);
    await store.save({ tenantId: TENANT, ...snapshot, updatedAt: 'fixed' });
  };
}

/** A restart: a fresh lock and fresh fakes, recovering whatever the store holds. */
async function restart(mod: Module, store: real.TenantStateStore) {
  const calls: Calls = { apply: 0, revert: 0 };
  const result = await mod.recoverPersistedTenants(store, mod.createApplyLock(), () =>
    fakeDeps(calls)
  );
  return { calls, result, finalState: result.recovered[0]?.finalState };
}

/** The abort lands while the 'backed-up' write is still in flight. */
async function cancelsDuringBackedUpWrite(mod: Module): Promise<boolean> {
  const calls: Calls = { apply: 0, revert: 0 };
  const machine = new mod.BumpStateMachine(
    fakeDeps(calls, {
      persist: persistInto(memoryStore(), (s) =>
        s.state === 'backed-up' && !s.abortRequested ? 20_000 : undefined
      ),
    }),
    mod.createApplyLock(),
    { bumpId: 'b' }
  );
  const run = machine.run();
  await vi.advanceTimersByTimeAsync(5_000);
  if (machine.getState() !== 'backed-up') return false;
  void machine.abort();
  await vi.advanceTimersByTimeAsync(30_000);
  return (await run) === 'cancelled' && calls.apply === 0 && calls.revert === 0;
}

/** The abort lands while the machine waits for the apply lock behind another tenant. */
async function cancelsWhileQueuedOnTheLock(mod: Module): Promise<boolean> {
  const lock = mod.createApplyLock();
  const first: Calls = { apply: 0, revert: 0 };
  const second: Calls = { apply: 0, revert: 0 };
  const ahead = new mod.BumpStateMachine(
    fakeDeps(first, {
      apply: async () => {
        first.apply += 1;
        await stallFor(20_000);
        return { ok: true };
      },
    }),
    lock,
    { bumpId: 'ahead' }
  );
  const queued = new mod.BumpStateMachine(fakeDeps(second), lock, { bumpId: 'queued' });
  const aheadRun = ahead.run();
  await vi.advanceTimersByTimeAsync(1_000);
  const queuedRun = queued.run();
  await vi.advanceTimersByTimeAsync(1_000);
  if (ahead.getState() !== 'applying' || queued.getState() !== 'backed-up') return false;
  void queued.abort();
  await vi.advanceTimersByTimeAsync(30_000);
  return (
    (await aheadRun) === 'done' &&
    (await queuedRun) === 'cancelled' &&
    second.apply === 0 &&
    second.revert === 0
  );
}

/** `abort()` settles only once the store holds the request. */
async function abortIsSavedWhenItSettles(mod: Module): Promise<boolean> {
  const store = memoryStore();
  const calls: Calls = { apply: 0, revert: 0 };
  const machine = new mod.BumpStateMachine(
    fakeDeps(calls, {
      persist: persistInto(store),
      apply: async () => {
        await stallFor(undefined);
        return { ok: true };
      },
    }),
    mod.createApplyLock(),
    { bumpId: 'b' }
  );
  void machine.run();
  await vi.advanceTimersByTimeAsync(1_000);
  await machine.abort();
  return (await store.load(TENANT))?.abortRequested === true;
}

/**
 * The 'applying' write is slow and the abort's is not. The abort must still
 * be what the store holds last, or a restart reads the stale step and
 * finishes the tenant.
 */
async function abortOutlastsTheWriteItInterrupted(mod: Module): Promise<BumpState | undefined> {
  const store = memoryStore();
  const calls: Calls = { apply: 0, revert: 0 };
  const machine = new mod.BumpStateMachine(
    fakeDeps(calls, {
      persist: persistInto(store, (s) =>
        s.state === 'applying' && !s.abortRequested ? 20_000 : undefined
      ),
      apply: async () => {
        await stallFor(undefined);
        return { ok: true };
      },
    }),
    mod.createApplyLock(),
    { bumpId: 'b' }
  );
  void machine.run();
  await vi.advanceTimersByTimeAsync(5_000);
  if (machine.getState() !== 'applying') return undefined;
  void machine.abort();
  await vi.advanceTimersByTimeAsync(30_000);
  // The process dies here, with the apply still in flight.
  return (await restart(mod, store)).finalState;
}

/** An abort saved during a timed-out apply, then a crash: recovery must revert. */
async function recoversAbortedApplyAs(mod: Module): Promise<BumpState | undefined> {
  const store = memoryStore();
  const calls: Calls = { apply: 0, revert: 0 };
  const machine = new mod.BumpStateMachine(
    fakeDeps(calls, {
      persist: persistInto(store),
      apply: async () => {
        await stallFor(undefined);
        return { ok: true };
      },
    }),
    mod.createApplyLock(),
    { bumpId: 'b' }
  );
  void machine.run();
  await vi.advanceTimersByTimeAsync(1_000);
  await machine.abort();
  return (await restart(mod, store)).finalState;
}

/** The abort lands while 'done' is being written: nobody will watch the bake. */
async function revertsAnAbortDuringTheDoneWrite(mod: Module): Promise<BumpState | undefined> {
  const calls: Calls = { apply: 0, revert: 0 };
  const machine = new mod.BumpStateMachine(
    fakeDeps(calls, {
      persist: persistInto(memoryStore(), (s) =>
        s.state === 'done' && !s.abortRequested ? 20_000 : undefined
      ),
    }),
    mod.createApplyLock(),
    { bumpId: 'b' }
  );
  const run = machine.run();
  await vi.advanceTimersByTimeAsync(5_000);
  if (machine.getState() !== 'done') return undefined;
  void machine.abort();
  await vi.advanceTimersByTimeAsync(30_000);
  return run;
}

const DONE_AND_ABORTED: real.PersistedTenantState = {
  tenantId: TENANT,
  state: 'done',
  pageSent: false,
  abortRequested: true,
  bumpId: 'b',
  updatedAt: 'fixed',
};

describe('an abort in a pre-apply state', () => {
  it('cancels when it lands during the backed-up write', async () => {
    expect(await cancelsDuringBackedUpWrite(real)).toBe(true);
  });

  it('cancels when it lands while queued on the apply lock', async () => {
    expect(await cancelsWhileQueuedOnTheLock(real)).toBe(true);
  });
});

describe('a saved abort', () => {
  it('is in the store by the time abort() settles', async () => {
    expect(await abortIsSavedWhenItSettles(real)).toBe(true);
  });

  it('round-trips through the file store', async () => {
    vi.useRealTimers();
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ring-abort-'));
    try {
      const store = real.createFileTenantStateStore(dir);
      await store.save(DONE_AND_ABORTED);
      expect(await store.load(TENANT)).toEqual(DONE_AND_ABORTED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lands after the slower write it interrupted, so a restart reverts', async () => {
    expect(await abortOutlastsTheWriteItInterrupted(real)).toBe('reverted');
  });

  it('turns a crash mid-apply into a revert on restart, never done', async () => {
    expect(await recoversAbortedApplyAs(real)).toBe('reverted');
  });

  it('reverts a persisted done on restart', async () => {
    const { calls, finalState } = await restart(real, memoryStore([DONE_AND_ABORTED]));
    expect(finalState).toBe('reverted');
    expect(calls.revert).toBe(1);
  });

  it('leaves a persisted done with no abort alone on restart', async () => {
    const { calls, finalState } = await restart(
      real,
      memoryStore([{ ...DONE_AND_ABORTED, abortRequested: false }])
    );
    expect(finalState).toBe('done');
    expect(calls.revert).toBe(0);
  });

  it('reverts when it lands during the done write', async () => {
    expect(await revertsAnAbortDuringTheDoneWrite(real)).toBe('reverted');
  });
});

/**
 * Sabotage pairs. Each mutation breaks one line of a copy of `src/`; the
 * scenario must fail on the copy and pass on the real source.
 */
describe('sabotage pairs', () => {
  const sabotaged = (mutation: Mutation) => importSabotaged<Module>('index.ts', [mutation]);

  const IN_LOCK_CHECK: Mutation = {
    file: 'bumpStateMachine.ts',
    find: "if (this.abortRequested) return 'cancel';",
    replace: '',
  };

  it('without the check inside the lock, an abort during the backed-up write still migrates', async () => {
    expect(await cancelsDuringBackedUpWrite(await sabotaged(IN_LOCK_CHECK))).toBe(false);
    expect(await cancelsDuringBackedUpWrite(real)).toBe(true);
  });

  it('without the check inside the lock, an abort queued on the lock still migrates', async () => {
    expect(await cancelsWhileQueuedOnTheLock(await sabotaged(IN_LOCK_CHECK))).toBe(false);
    expect(await cancelsWhileQueuedOnTheLock(real)).toBe(true);
  });

  it('an abort kept in memory only is not in the store, and a restart finishes the tenant', async () => {
    const mutation: Mutation = {
      file: 'bumpStateMachine.ts',
      find: '    this.abortRequested = true;\n    return this.persistSnapshot();',
      replace: '    this.abortRequested = true;\n    return Promise.resolve();',
    };
    const mod = await sabotaged(mutation);
    expect(await abortIsSavedWhenItSettles(mod)).toBe(false);
    expect(await recoversAbortedApplyAs(mod)).toBe('done');
    expect(await abortIsSavedWhenItSettles(real)).toBe(true);
    expect(await recoversAbortedApplyAs(real)).toBe('reverted');
  });

  it('unordered writes let the stale step land over the abort, and a restart finishes the tenant', async () => {
    const mod = await sabotaged({
      file: 'bumpStateMachine.ts',
      find: 'const write = this.persistTail.then(() => this.deps.persist?.(snapshot));',
      replace: 'const write = Promise.resolve(this.deps.persist?.(snapshot));',
    });
    expect(await abortOutlastsTheWriteItInterrupted(mod)).toBe('done');
    expect(await abortOutlastsTheWriteItInterrupted(real)).toBe('reverted');
  });

  it('recovery that drops the saved abort finishes an aborted apply as done', async () => {
    const mod = await sabotaged({
      file: 'recovery.ts',
      find: 'abortRequested: record.abortRequested === true,',
      replace: '',
    });
    expect(await recoversAbortedApplyAs(mod)).toBe('done');
    expect(await recoversAbortedApplyAs(real)).toBe('reverted');
  });

  it('recovery that leaves an aborted done alone keeps an unbaked tenant on the new version', async () => {
    const mod = await sabotaged({
      file: 'recovery.ts',
      find: 'return machine.abortAfterDone();',
      replace: 'return Promise.resolve(machine.getState());',
    });
    expect((await restart(mod, memoryStore([DONE_AND_ABORTED]))).finalState).toBe('done');
    expect((await restart(real, memoryStore([DONE_AND_ABORTED]))).finalState).toBe('reverted');
  });

  it('without the check after the done write, an abort that lands during it is lost', async () => {
    const mod = await sabotaged({
      file: 'bumpStateMachine.ts',
      find: '        return this.abortAfterDone();\n',
      replace: '        return this.state;\n',
    });
    expect(await revertsAnAbortDuringTheDoneWrite(mod)).toBe('done');
    expect(await revertsAnAbortDuringTheDoneWrite(real)).toBe('reverted');
  });
});
