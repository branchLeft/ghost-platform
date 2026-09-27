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
    awaitApplySettled: vi.fn(async () => ok),
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
    expect(deps.page).toHaveBeenCalledWith('edge unreachable', expect.any(String));
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
    expect(deps.page).toHaveBeenCalledWith('first', expect.any(String));
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

describe('BumpStateMachine -- verify() that cannot even run', () => {
  it('an unverifiable outcome pages once as failed-unsafe, rather than being read as pass or ordinary fail', async () => {
    const deps = fakeDeps({
      verify: vi.fn(async () => {
        throw new Error('health endpoint unreachable');
      }),
    });
    const m = new BumpStateMachine(deps, createApplyLock());

    const finalState = await m.run();

    expect(finalState).toBe('failed-unsafe');
    expect(deps.revertTraffic).not.toHaveBeenCalled();
    expect(deps.page).toHaveBeenCalledTimes(1);
    expect(deps.page).toHaveBeenCalledWith('health endpoint unreachable', expect.any(String));
  });

  it('a verify() that throws something other than an Error still pages, with a literal fallback reason', async () => {
    const deps = fakeDeps({
      verify: vi.fn(async () => {
        throw 'boom';
      }),
    });
    const m = new BumpStateMachine(deps, createApplyLock());

    await m.run();

    expect(deps.page).toHaveBeenCalledWith('verify() threw', expect.any(String));
  });
});

describe('BumpStateMachine -- the revert-failure fallback reason', () => {
  it('falls back to the literal string when neither the revert result nor the caller names a reason', async () => {
    const deps = fakeDeps({ revertTraffic: vi.fn(async () => ({ ok: false })) });
    const m = new BumpStateMachine(deps, createApplyLock());
    await m.run();

    // abortAfterDone calls the revert path with no carried reason of its
    // own, and this revertTraffic() gives none either -- the one call
    // shape that reaches the literal fallback string.
    await m.abortAfterDone();

    expect(deps.page).toHaveBeenCalledWith('revert failed', expect.any(String));
  });
});

describe('BumpStateMachine -- persist is called before the side effect for each state (LLD-4 §04/§05 durability)', () => {
  it('persists every transition in order, before backup/apply/verify each run', async () => {
    const timeline: string[] = [];
    const deps = fakeDeps({
      backup: vi.fn(async () => {
        timeline.push('call:backup');
        return { ok: true };
      }),
      apply: vi.fn(async () => {
        timeline.push('call:apply');
        return { ok: true };
      }),
      verify: vi.fn(async () => {
        timeline.push('call:verify');
        return { ok: true };
      }),
      persist: vi.fn(async (snapshot) => {
        timeline.push(`persist:${snapshot.state}`);
      }),
    });
    const m = new BumpStateMachine(deps, createApplyLock());

    await m.run();

    // One shared timeline: each side effect's call comes strictly after
    // its own state was durably recorded, never before -- a `persist`
    // fired-and-forgotten rather than awaited could let `call:*` jump
    // ahead of its matching `persist:*` entry.
    expect(timeline).toEqual([
      'persist:backing-up',
      'call:backup',
      'persist:backed-up',
      'persist:applying',
      'call:apply',
      'persist:verifying',
      'call:verify',
      'persist:done',
    ]);
  });

  it('sabotage: a persist that never resolves stalls the transition, proving run() actually awaits it', async () => {
    const deps = fakeDeps({ persist: vi.fn(() => new Promise<void>(() => {})) });
    const m = new BumpStateMachine(deps, createApplyLock());

    const runPromise = m.run();
    await tick();

    // If `run()` merely fired `persist` without awaiting it, `backup()`
    // would already have been reached; it hasn't, because the very first
    // transition ('backing-up') is still stuck awaiting the store.
    expect(deps.backup).not.toHaveBeenCalled();
    expect(m.getState()).toBe('backing-up');

    void runPromise; // left deliberately unsettled -- this is the point.
  });
});

describe('BumpStateMachine -- recovery methods reject a mismatched starting state', () => {
  it('recoverFromApplying refuses a machine not recovered into applying', async () => {
    const m = new BumpStateMachine(fakeDeps(), createApplyLock());
    await expect(m.recoverFromApplying()).rejects.toThrow(/expected 'applying'/);
  });

  it('recoverFromRevertInFlight refuses a machine not recovered into verifying or reverting', async () => {
    const m = new BumpStateMachine(fakeDeps(), createApplyLock());
    await expect(m.recoverFromRevertInFlight()).rejects.toThrow(
      /expected 'verifying' or 'reverting'/
    );
  });

  it('recoverFromReverted refuses a machine not recovered into reverted', async () => {
    const m = new BumpStateMachine(fakeDeps(), createApplyLock());
    await expect(m.recoverFromReverted()).rejects.toThrow(/expected 'reverted'/);
  });

  it('recoverFromClosing refuses a machine not recovered into closing', async () => {
    const m = new BumpStateMachine(fakeDeps(), createApplyLock());
    await expect(m.recoverFromClosing()).rejects.toThrow(/expected 'closing'/);
  });

  it('recoverUnpagedFailure refuses a machine not recovered into failed-unsafe', async () => {
    const m = new BumpStateMachine(fakeDeps(), createApplyLock());
    await expect(m.recoverUnpagedFailure('x')).rejects.toThrow(/expected 'failed-unsafe'/);
  });

  it('recoverAsCancelled refuses a machine recovered into applying', async () => {
    const m = new BumpStateMachine(fakeDeps(), createApplyLock(), {
      recovered: { state: 'applying' },
    });
    await expect(m.recoverAsCancelled()).rejects.toThrow(
      /expected 'pending', 'backing-up' or 'backed-up'/
    );
  });
});

describe('BumpStateMachine -- recoverFromApplying waits for the migration to settle before touching the colour', () => {
  it('a confirmed-settled migration is verified and can land on done, never re-calling apply()', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock(), { recovered: { state: 'applying' } });

    const finalState = await m.recoverFromApplying();

    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.awaitApplySettled).toHaveBeenCalledTimes(1);
    expect(deps.verify).toHaveBeenCalledTimes(1);
    expect(finalState).toBe('done');
  });

  it('an outcome that cannot be confirmed settled goes straight to failed-unsafe, never touching verify, revertTraffic or stopColour', async () => {
    const deps = fakeDeps({
      awaitApplySettled: vi.fn(async () => ({ ok: false, reason: 'migrations_lock still held' })),
    });
    const m = new BumpStateMachine(deps, createApplyLock(), { recovered: { state: 'applying' } });

    const finalState = await m.recoverFromApplying();

    expect(finalState).toBe('failed-unsafe');
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.revertTraffic).not.toHaveBeenCalled();
    expect(deps.stopColour).not.toHaveBeenCalled();
    expect(deps.page).toHaveBeenCalledWith('migrations_lock still held', expect.any(String));
  });

  it('a settled-but-unhealthy migration reverts normally, once settling is confirmed', async () => {
    const deps = fakeDeps({ verify: vi.fn(async () => ({ ok: false, reason: 'unhealthy' })) });
    const m = new BumpStateMachine(deps, createApplyLock(), { recovered: { state: 'applying' } });

    const finalState = await m.recoverFromApplying();

    expect(finalState).toBe('reverted');
    expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
  });

  it('a probe that throws is treated as unsettled, not as a pass, and never touches the colour', async () => {
    const deps = fakeDeps({
      awaitApplySettled: vi.fn(async () => {
        throw new Error('migrations_lock database unreachable');
      }),
    });
    const m = new BumpStateMachine(deps, createApplyLock(), { recovered: { state: 'applying' } });

    const finalState = await m.recoverFromApplying();

    expect(finalState).toBe('failed-unsafe');
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.revertTraffic).not.toHaveBeenCalled();
    expect(deps.stopColour).not.toHaveBeenCalled();
    expect(deps.page).toHaveBeenCalledWith(
      'migrations_lock database unreachable',
      expect.any(String)
    );
  });

  it('a probe that never resolves times out rather than hanging recovery forever, and never touches the colour', async () => {
    const deps = fakeDeps({ awaitApplySettled: vi.fn(() => new Promise<StepResult>(() => {})) });
    const m = new BumpStateMachine(deps, createApplyLock(), {
      recovered: { state: 'applying' },
      applySettleTimeoutMs: 20,
    });

    const finalState = await m.recoverFromApplying();

    expect(finalState).toBe('failed-unsafe');
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.revertTraffic).not.toHaveBeenCalled();
    expect(deps.stopColour).not.toHaveBeenCalled();
    expect(deps.page).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
      expect.any(String)
    );
  });

  it('holds the ApplyLock for the whole settle-and-verify tail, serialising against a live apply() on another tenant', async () => {
    const lock = createApplyLock();
    const order: string[] = [];

    let releaseSettle!: (v: StepResult) => void;
    const settleGate = new Promise<StepResult>((resolve) => {
      releaseSettle = resolve;
    });
    const recovering = new BumpStateMachine(
      fakeDeps({
        awaitApplySettled: vi.fn(() => {
          order.push('recovering:settle-start');
          return settleGate;
        }),
        verify: vi.fn(async () => {
          order.push('recovering:verify');
          return { ok: true };
        }),
      }),
      lock,
      { recovered: { state: 'applying' } }
    );
    const liveDeps = fakeDeps({
      apply: vi.fn(async () => {
        order.push('live:apply');
        return { ok: true };
      }),
    });
    const live = new BumpStateMachine(liveDeps, lock);

    const recoverPromise = recovering.recoverFromApplying();
    await tick();
    // `live` queues behind `recovering` on the same lock -- its apply()
    // must not run until the recovery tail releases the lock.
    const livePromise = live.run();
    await tick();
    expect(liveDeps.apply).not.toHaveBeenCalled();

    releaseSettle({ ok: true });
    await recoverPromise;
    await livePromise;

    expect(order).toEqual(['recovering:settle-start', 'recovering:verify', 'live:apply']);
  });
});

describe('BumpStateMachine -- recoverFromClosing retries the teardown a crash may have interrupted', () => {
  it('retries stopColour(old) and lands on closed', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock(), { recovered: { state: 'closing' } });

    const finalState = await m.recoverFromClosing();

    expect(deps.stopColour).toHaveBeenCalledWith('old');
    expect(finalState).toBe('closed');
  });
});

describe('BumpStateMachine -- closeBakeWindow persists closing before the teardown runs', () => {
  it('persists closing strictly before stopColour(old), and closed strictly after', async () => {
    const timeline: string[] = [];
    const deps = fakeDeps({
      stopColour: vi.fn(async (which) => {
        timeline.push(`call:stopColour:${which}`);
      }),
      persist: vi.fn(async (snapshot) => {
        timeline.push(`persist:${snapshot.state}`);
      }),
    });
    const m = new BumpStateMachine(deps, createApplyLock());
    await m.run();
    timeline.length = 0;

    await m.closeBakeWindow();

    expect(timeline).toEqual(['persist:closing', 'call:stopColour:old', 'persist:closed']);
  });
});

describe('BumpStateMachine -- recoverUnpagedFailure pages exactly once, across a restart', () => {
  it('pages when pageSent is false, then persists pageSent: true', async () => {
    const persisted: Array<{ state: string; pageSent: boolean }> = [];
    const deps = fakeDeps({
      persist: vi.fn(async (snapshot) => {
        persisted.push({ state: snapshot.state, pageSent: snapshot.pageSent });
      }),
    });
    const m = new BumpStateMachine(deps, createApplyLock(), {
      recovered: { state: 'failed-unsafe', pageSent: false },
    });

    const finalState = await m.recoverUnpagedFailure('unpaged after crash');

    expect(finalState).toBe('failed-unsafe');
    expect(deps.page).toHaveBeenCalledTimes(1);
    expect(deps.page).toHaveBeenCalledWith('unpaged after crash', expect.any(String));
    expect(persisted).toEqual([{ state: 'failed-unsafe', pageSent: true }]);
  });

  it('never pages again when recovered with pageSent already true', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock(), {
      recovered: { state: 'failed-unsafe', pageSent: true },
    });

    await m.recoverUnpagedFailure('should never be sent');

    expect(deps.page).not.toHaveBeenCalled();
  });
});

describe('BumpStateMachine -- done can be claimed by only one of closeBakeWindow/abortAfterDone', () => {
  it('the loser of a same-tick race is refused, never silently overwriting the winner', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());
    await m.run();
    expect(m.getState()).toBe('done');

    // Neither call is awaited before the other starts -- the exact shape
    // of the race the review named: a bake-window timer and the watcher's
    // health regression landing in the same tick.
    const closePromise = m.closeBakeWindow();
    const abortPromise = m.abortAfterDone();

    await expect(abortPromise).rejects.toThrow(/not 'done'/);
    expect(await closePromise).toBe('closed');
    expect(deps.stopColour).toHaveBeenCalledTimes(1);
    expect(deps.stopColour).toHaveBeenCalledWith('old');
    // The loser never got as far as touching revertTraffic.
    expect(deps.revertTraffic).not.toHaveBeenCalled();
  });

  it('the race resolves the other way just as cleanly when abortAfterDone is called first', async () => {
    const deps = fakeDeps();
    const m = new BumpStateMachine(deps, createApplyLock());
    await m.run();

    const abortPromise = m.abortAfterDone();
    const closePromise = m.closeBakeWindow();

    await expect(closePromise).rejects.toThrow(/not 'done'/);
    expect(await abortPromise).toBe('reverted');
    expect(deps.revertTraffic).toHaveBeenCalledTimes(1);
    expect(deps.stopColour).toHaveBeenCalledWith('new');
  });
});
