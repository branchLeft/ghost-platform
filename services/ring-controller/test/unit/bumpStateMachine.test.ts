import { describe, expect, it, vi } from 'vitest';
import {
  BumpStateMachine,
  type BumpDependencies,
  type StepResult,
} from '../../src/bumpStateMachine.js';
import { createApplyLock } from '../../src/applyLock.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Waits at least one macrotask -- enough for every `await` inside `run()` up to a deliberately-held step to have settled. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeDeps(overrides: Partial<BumpDependencies> = {}): BumpDependencies {
  const ok: StepResult = { ok: true };
  return {
    backup: vi.fn(async () => ok),
    apply: vi.fn(async () => ok),
    verify: vi.fn(async () => ok),
    revertTraffic: vi.fn(async () => ok),
    stopColour: vi.fn(async () => undefined),
    page: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('BumpStateMachine -- the happy path', () => {
  it('runs pending through backing-up, backed-up, applying, verifying to done', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());

    const finalState = await m.run();

    expect(finalState).toBe('done');
    expect(m.getState()).toBe('done');
    expect(deps.backup).toHaveBeenCalledTimes(1);
    expect(deps.apply).toHaveBeenCalledTimes(1);
    expect(deps.verify).toHaveBeenCalledTimes(1);
    expect(deps.revertTraffic).not.toHaveBeenCalled();
    expect(deps.page).not.toHaveBeenCalled();
  });

  it('closes the bake window by stopping the old colour, only from done', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());
    await m.run();

    const finalState = await m.closeBakeWindow();

    expect(finalState).toBe('closed');
    expect(deps.stopColour).toHaveBeenCalledTimes(1);
    expect(deps.stopColour).toHaveBeenCalledWith('old');
  });

  it('refuses to close the bake window from any other state', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());
    // Still 'pending' -- run() has not been called.
    await expect(m.closeBakeWindow()).rejects.toThrow(/not 'done'/);
  });

  it('refuses run() a second time -- there is no automatic retry path', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());
    await m.run();

    await expect(m.run()).rejects.toThrow();
  });
});

describe('BumpStateMachine -- the abort table (LLD-4 §05)', () => {
  it('pending: abort cancels before anything is touched', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());

    m.abort();
    const finalState = await m.run();

    expect(finalState).toBe('cancelled');
    expect(deps.backup).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('backing-up: abort lets the in-flight backup finish, then cancels', async () => {
    const backupGate = deferred<StepResult>();
    const deps = fakeDeps({ backup: vi.fn(() => backupGate.promise) });
    const m = new BumpStateMachine(deps, createApplyLock());

    const runPromise = m.run();
    await tick();
    expect(m.getState()).toBe('backing-up');

    m.abort();
    // The abort must not cut the backup short.
    expect(deps.apply).not.toHaveBeenCalled();

    backupGate.resolve({ ok: true });
    const finalState = await runPromise;

    expect(finalState).toBe('cancelled');
    expect(deps.backup).toHaveBeenCalledTimes(1);
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('applying: abort waits for the migration to finish, never calls verify, and reverts', async () => {
    const applyGate = deferred<StepResult>();
    const deps = fakeDeps({ apply: vi.fn(() => applyGate.promise) });
    const m = new BumpStateMachine(deps, createApplyLock());

    const runPromise = m.run();
    await tick();
    expect(m.getState()).toBe('applying');

    m.abort();
    // The migration is still running -- nothing has reacted to the abort yet.
    expect(deps.revertTraffic).not.toHaveBeenCalled();

    applyGate.resolve({ ok: true });
    const finalState = await runPromise;

    expect(deps.apply).toHaveBeenCalledTimes(1);
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
    expect(finalState).toBe('reverted');
    expect(deps.stopColour).toHaveBeenCalledTimes(1);
    expect(deps.stopColour).toHaveBeenCalledWith('new');
  });

  it('applying: abort still waits even when the migration itself is failing', async () => {
    const applyGate = deferred<StepResult>();
    const deps = fakeDeps({ apply: vi.fn(() => applyGate.promise) });
    const m = new BumpStateMachine(deps, createApplyLock());

    const runPromise = m.run();
    await tick();
    m.abort();

    applyGate.resolve({ ok: false, reason: 'migration failed' });
    const finalState = await runPromise;

    expect(finalState).toBe('reverted');
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it('verifying: abort while verification is in flight reverts rather than completing', async () => {
    const verifyGate = deferred<StepResult>();
    const deps = fakeDeps({ verify: vi.fn(() => verifyGate.promise) });
    const m = new BumpStateMachine(deps, createApplyLock());

    const runPromise = m.run();
    await tick();
    expect(m.getState()).toBe('verifying');

    m.abort();
    verifyGate.resolve({ ok: true });
    const finalState = await runPromise;

    // Even though verify() itself reported healthy, the abort landed in
    // 'verifying', so the table's rule for that state (revert) applies.
    expect(finalState).toBe('reverted');
    expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
  });

  it('done: abort after the bump completed still reverts, since the old colour is still there', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());

    const finalState = await m.run();
    expect(finalState).toBe('done');

    const afterAbort = await m.abortAfterDone();

    expect(afterAbort).toBe('reverted');
    expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
    expect(deps.stopColour).toHaveBeenCalledTimes(1);
    expect(deps.stopColour).toHaveBeenCalledWith('new');
  });

  it('abortAfterDone refuses to run from any state but done', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());
    await expect(m.abortAfterDone()).rejects.toThrow(/not 'done'/);
  });
});

describe('BumpStateMachine -- failures with no abort involved', () => {
  it('a backup that fails its floor assertion stops cleanly -- nothing was touched', async () => {
    const deps = fakeDeps({
      backup: vi.fn(async () => ({ ok: false, reason: 'floor assertion failed' })),
    });
    const m = new BumpStateMachine(deps, createApplyLock());

    const finalState = await m.run();

    expect(finalState).toBe('backup-failed');
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.page).not.toHaveBeenCalled();
  });

  it('a migration that fails on its own is reverted, not retried', async () => {
    const deps = fakeDeps({
      apply: vi.fn(async () => ({ ok: false, reason: 'irreversible migration refused' })),
    });
    const m = new BumpStateMachine(deps, createApplyLock());

    const finalState = await m.run();

    expect(finalState).toBe('reverted');
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
  });

  it('a failed health verification is reverted', async () => {
    const deps = fakeDeps({
      verify: vi.fn(async () => ({ ok: false, reason: 'never answered 200' })),
    });
    const m = new BumpStateMachine(deps, createApplyLock());

    const finalState = await m.run();

    expect(finalState).toBe('reverted');
    expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
  });
});

describe('BumpStateMachine -- failed-unsafe pages once and never retries (LLD-4 §05)', () => {
  it('an unrevertable tenant pages exactly once', async () => {
    const deps = fakeDeps({
      verify: vi.fn(async () => ({ ok: false, reason: 'content check failed' })),
      revertTraffic: vi.fn(async () => ({ ok: false, reason: 'edge unreachable' })),
    });
    const m = new BumpStateMachine(deps, createApplyLock());

    const finalState = await m.run();

    expect(finalState).toBe('failed-unsafe');
    expect(deps.page).toHaveBeenCalledTimes(1);
    expect(deps.page).toHaveBeenCalledWith('edge unreachable');
  });

  it('run() cannot be called again once failed-unsafe is reached', async () => {
    const deps = fakeDeps({
      verify: vi.fn(async () => ({ ok: false, reason: 'content check failed' })),
      revertTraffic: vi.fn(async () => ({ ok: false, reason: 'edge unreachable' })),
    });
    const m = new BumpStateMachine(deps, createApplyLock());
    await m.run();

    expect(m.getState()).toBe('failed-unsafe');
    await expect(m.run()).rejects.toThrow();
    expect(deps.page).toHaveBeenCalledTimes(1);
  });

  it('wiring sabotage: the pageSent guard is what stops a second page, not the shape of the call path', async () => {
    // Reaches into the private guard the same way the backup worker's own
    // "wiring sabotage" tests call an internal function directly to prove
    // a guard is load-bearing on its own, rather than an accident of how
    // few call sites there are today.
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());
    const failUnsafe = (
      m as unknown as { failUnsafe(reason: string): Promise<string> }
    ).failUnsafe.bind(m);

    await failUnsafe('first');
    await failUnsafe('second');

    expect(deps.page).toHaveBeenCalledTimes(1);
    expect(deps.page).toHaveBeenCalledWith('first');
  });
});

describe('BumpStateMachine -- at most one tenant is ever in applying (LLD-4 §04)', () => {
  it('two bumps sharing one ApplyLock never overlap inside applying', async () => {
    const lock = createApplyLock();
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeDeps = (): BumpDependencies =>
      fakeDeps({
        apply: vi.fn(async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await tick();
          concurrent--;
          return { ok: true };
        }),
      });

    const m1 = new BumpStateMachine(makeDeps(), lock);
    const m2 = new BumpStateMachine(makeDeps(), lock);

    const [r1, r2] = await Promise.all([m1.run(), m2.run()]);

    expect(r1).toBe('done');
    expect(r2).toBe('done');
    expect(maxConcurrent).toBe(1);
  });

  it('sabotage control: the same two applies, with nothing serialising them, do overlap', async () => {
    // Proves the lock above is what prevents the overlap, not scheduling
    // luck: the identical pair of apply() bodies, called directly with
    // no ApplyLock in between, DOES exceed one concurrent occupant.
    let concurrent = 0;
    let maxConcurrent = 0;

    const rawApply = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await tick();
      concurrent--;
    };

    await Promise.all([rawApply(), rawApply()]);

    expect(maxConcurrent).toBe(2);
  });
});
