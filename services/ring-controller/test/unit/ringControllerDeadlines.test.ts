/**
 * Every outside call `runRelease` awaits has a deadline, and a call that
 * misses it fails its member (a hold), never passes it and never stalls the
 * release. Driven with fake timers: a hung host is a promise that never
 * settles, and time is advanced until the release settles or the budget
 * runs out.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BumpStateMachine } from '../../src/bumpStateMachine.js';
import { createApplyLock } from '../../src/applyLock.js';
import {
  DEFAULT_CALL_DEADLINES,
  DeadlineExceededError,
  type CallDeadlines,
} from '../../src/deadlines.js';
import { recoverPersistedTenants } from '../../src/recovery.js';
import * as real from '../../src/ringController.js';
import type { Health, ReleaseOutcome } from '../../src/ringController.js';
import {
  CLEAN_ENV,
  DIGEST,
  RELEASE,
  bakeConfig,
  makeFleet,
  memoryStore,
  type FleetOptions,
} from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = { runRelease: typeof real.runRelease };

const SHORT: Partial<CallDeadlines> = {
  runGatesMs: 5_000,
  bumpMs: 5_000,
  healthMs: 1_000,
  reportedErrorsMs: 1_000,
  listMembersMs: 1_000,
  abortMs: 1_000,
  recordPromotionMs: 1_000,
  closeBakeWindowMs: 1_000,
  revertMs: 1_000,
  holdMs: 1_000,
  sleepOverrunMs: 1_000,
};

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

interface Settled {
  settled: boolean;
  outcome: ReleaseOutcome | undefined;
  error: unknown;
}

/** Advances fake time in `stepMs` steps until `promise` settles or `budgetMs` is spent. */
async function advanceUntilSettled(
  promise: Promise<ReleaseOutcome>,
  budgetMs: number,
  stepMs = 500
): Promise<Settled> {
  const state: Settled = { settled: false, outcome: undefined, error: undefined };
  promise.then(
    (outcome) => {
      state.settled = true;
      state.outcome = outcome;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    }
  );
  for (let spent = 0; !state.settled && spent <= budgetMs; spent += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  return state;
}

async function drive(mod: Module, options: FleetOptions, budgetMs = 60_000, stepMs = 500) {
  const fleet = makeFleet({ deadlines: SHORT, ...options });
  const result = await advanceUntilSettled(
    mod.runRelease(RELEASE, fleet.deps, bakeConfig(), CLEAN_ENV),
    budgetMs,
    stepMs
  );
  return { fleet, ...result };
}

const hangFor =
  (tenant: string) =>
  (tenantId: string): Promise<Health> =>
    tenantId === tenant ? never() : Promise.resolve({ healthy: true, reportedDigest: DIGEST });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  cleanupSabotageTmp();
});

describe('a hung health probe', () => {
  it('fails that member as probe-failed, reverts nothing, and stops the release', async () => {
    const { fleet, settled, outcome } = await drive(real, { health: hangFor('entry-1') });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({
      status: 'held',
      at: 'entry',
      reason: 'probe-failed',
      tenantId: 'entry-1',
    });
    expect((outcome as { detail: string }).detail).toContain(
      'health() did not answer within 1000ms'
    );
    expect(fleet.holds).toHaveLength(1);
    expect(fleet.events.filter((e) => e.startsWith('revert:'))).toEqual([]);
    expect(fleet.stoppedOld()).toEqual(['canary-mysql', 'demo-1']);
    expect(fleet.bumpOrder()).not.toContain('pro-1');
  });
});

describe('a hung reported-errors probe', () => {
  it('fails that member as probe-failed and stops the release', async () => {
    const { fleet, settled, outcome } = await drive(real, {
      reportedErrors: (tenantId) => (tenantId === 'demo-1' ? never() : []),
    });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({
      status: 'held',
      at: 'demos',
      reason: 'probe-failed',
      tenantId: 'demo-1',
    });
    expect((outcome as { detail: string }).detail).toContain(
      'reportedErrors() did not answer within 1000ms'
    );
    expect(fleet.stoppedOld()).toEqual(['canary-mysql']);
    expect(fleet.bumpOrder()).toEqual(['canary-mysql', 'demo-1']);
  });
});

describe('hung gates', () => {
  it('hold the release as gate-red and bump nobody', async () => {
    const { fleet, settled, outcome } = await drive(real, { gates: () => never() });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ status: 'held', at: 'gates', reason: 'gate-red' });
    expect((outcome as { detail: string }).detail).toContain(
      'runGates() did not answer within 5000ms'
    );
    expect(fleet.calls.newBump).toBe(0);
    expect(fleet.holds).toHaveLength(1);
  });
});

describe('a hung bump', () => {
  it('fails that member as bump-not-done and never touches the next one', async () => {
    const { fleet, settled, outcome } = await drive(real, {
      tenants: { 'canary-mysql': { stall: { step: 'backup' } } },
    });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({
      status: 'held',
      at: 'slot-0',
      reason: 'bump-not-done',
      tenantId: 'canary-mysql',
    });
    expect((outcome as { detail: string }).detail).toContain(
      "the bump did not answer within 5000ms, still in 'backing-up'; abort requested and saved"
    );
    expect(fleet.calls.newBump).toBe(1);
    expect(fleet.calls.health).toBe(0);
    expect(fleet.stoppedOld()).toEqual([]);
  });

  it('asks the machine to abort, so a backup that finishes late cancels instead of applying', async () => {
    const { fleet, settled } = await drive(real, {
      tenants: { 'canary-mysql': { stall: { step: 'backup', ms: 20_000 } } },
    });
    expect(settled).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    const machine = fleet.machines.get('canary-mysql') as BumpStateMachine;
    expect(machine.getState()).toBe('cancelled');
    expect(fleet.bumpOrder()).toEqual([]);
  });

  it('never interrupts an apply, and a late one is reverted rather than left on the new version', async () => {
    const { fleet, settled, outcome } = await drive(real, {
      tenants: { 'canary-mysql': { stall: { step: 'apply', ms: 20_000 } } },
    });
    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ reason: 'bump-not-done', tenantId: 'canary-mysql' });
    expect((outcome as { detail: string }).detail).toContain("still in 'applying'");

    await vi.advanceTimersByTimeAsync(30_000);
    const machine = fleet.machines.get('canary-mysql') as BumpStateMachine;
    expect(machine.getState()).not.toBe('done');
    expect(fleet.events).toContain('revert:canary-mysql');
    expect(fleet.stoppedOld()).toEqual([]);
  });
});

describe('the deadlines themselves', () => {
  it('apply by default, with no deadlines passed', async () => {
    const fleet = makeFleet({ health: hangFor('canary-mysql') });
    const { settled, outcome } = await advanceUntilSettled(
      real.runRelease(RELEASE, fleet.deps, bakeConfig(), CLEAN_ENV),
      DEFAULT_CALL_DEADLINES.healthMs * 2
    );

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ reason: 'probe-failed', tenantId: 'canary-mysql' });
    expect((outcome as { detail: string }).detail).toContain(
      `within ${DEFAULT_CALL_DEADLINES.healthMs}ms`
    );
  });

  it('default to bounds that exist and are frozen', () => {
    expect(DEFAULT_CALL_DEADLINES).toEqual({
      runGatesMs: 30 * 60 * 1000,
      bumpMs: 60 * 60 * 1000,
      healthMs: 30 * 1000,
      reportedErrorsMs: 30 * 1000,
      listMembersMs: 60 * 1000,
      abortMs: 60 * 1000,
      recordPromotionMs: 60 * 1000,
      closeBakeWindowMs: 10 * 60 * 1000,
      revertMs: 10 * 60 * 1000,
      holdMs: 60 * 1000,
      sleepOverrunMs: 60 * 1000,
    });
    expect(Object.isFrozen(DEFAULT_CALL_DEADLINES)).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuse a bound of %s before any gate runs',
    async (ms) => {
      const fleet = makeFleet({ deadlines: { healthMs: ms } });

      await expect(real.runRelease(RELEASE, fleet.deps, bakeConfig(), CLEAN_ENV)).rejects.toThrow(
        RangeError
      );
      expect(fleet.calls.runGates).toBe(0);
    }
  );

  it.each(Object.keys(DEFAULT_CALL_DEADLINES) as (keyof CallDeadlines)[])(
    'refuse a zero bound for %s before any gate runs',
    async (key) => {
      const fleet = makeFleet({ deadlines: { [key]: 0 } });

      await expect(real.runRelease(RELEASE, fleet.deps, bakeConfig(), CLEAN_ENV)).rejects.toThrow(
        `call deadline '${key}'`
      );
      expect(fleet.calls.runGates).toBe(0);
    }
  );

  it('do not cut off calls that answer, and leave no timer behind', async () => {
    const { fleet, settled, outcome } = await drive(real, {}, 60_000, 10);

    expect(settled).toBe(true);
    expect(outcome).toEqual({ status: 'completed' });
    expect(fleet.holds).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * Sabotage pairs. Each breaks one real line of `src/` in a throwaway copy,
 * asserts the property fails there (the release hangs, or a timed-out member
 * passes), then asserts it holds on the real module.
 */
describe('sabotage pairs', () => {
  const sabotaged = (mutation: Mutation) =>
    importSabotaged<Module>('ringController.ts', [mutation]);

  async function expectPair(
    mutation: Mutation,
    scenario: (mod: Module) => Promise<boolean>
  ): Promise<void> {
    expect(await scenario(await sabotaged(mutation))).toBe(false);
    expect(await scenario(real)).toBe(true);
  }

  const heldAs = async (
    mod: Module,
    options: FleetOptions,
    expected: { reason: string; tenantId?: string; detail: string }
  ): Promise<boolean> => {
    const { settled, outcome } = await drive(mod, options);
    if (!settled || outcome?.status !== 'held') return false;
    return (
      outcome.reason === expected.reason &&
      (expected.tenantId === undefined || outcome.tenantId === expected.tenantId) &&
      (outcome.detail ?? '').includes(expected.detail)
    );
  };

  it('an unbounded health() lets a hung probe stall the release', async () => {
    await expectPair(
      {
        file: 'ringController.ts',
        find: "health: (tenantId) => withDeadline(deps.health(tenantId), deadlines.healthMs, 'health()'),",
        replace: 'health: deps.health,',
      },
      (mod) =>
        heldAs(
          mod,
          { health: hangFor('entry-1') },
          { reason: 'probe-failed', tenantId: 'entry-1', detail: 'health()' }
        )
    );
  });

  it('an unbounded reportedErrors() lets a hung probe stall the release', async () => {
    await expectPair(
      {
        file: 'ringController.ts',
        find: `withDeadline(
        deps.reportedErrors(tenantId, sinceMs),
        deadlines.reportedErrorsMs,
        'reportedErrors()'
      ),`,
        replace: 'deps.reportedErrors(tenantId, sinceMs),',
      },
      (mod) =>
        heldAs(
          mod,
          { reportedErrors: (tenantId) => (tenantId === 'demo-1' ? never() : []) },
          { reason: 'probe-failed', tenantId: 'demo-1', detail: 'reportedErrors()' }
        )
    );
  });

  it('unbounded gates let a hung gate host stall the release', async () => {
    await expectPair(
      {
        file: 'ringController.ts',
        find: "runGates: (digest) => withDeadline(deps.runGates(digest), deadlines.runGatesMs, 'runGates()'),",
        replace: 'runGates: deps.runGates,',
      },
      (mod) => heldAs(mod, { gates: () => never() }, { reason: 'gate-red', detail: 'runGates()' })
    );
  });

  it('an unbounded machine.run() lets a hung bump stall the release', async () => {
    await expectPair(
      {
        file: 'ringController.ts',
        find: "const state = await withDeadline(machine.run(), deps.deadlines.bumpMs, 'the bump');",
        replace: 'const state = await machine.run();',
      },
      (mod) =>
        heldAs(
          mod,
          { tenants: { 'canary-mysql': { stall: { step: 'backup' } } } },
          { reason: 'bump-not-done', tenantId: 'canary-mysql', detail: 'did not answer' }
        )
    );
  });

  it('a timed-out bump read as done goes on to soak a member that never finished', async () => {
    await expectPair(
      { file: 'ringController.ts', find: "state: 'timed-out',", replace: "state: 'done'," },
      async (mod) => {
        const options: FleetOptions = {
          tenants: { 'canary-mysql': { stall: { step: 'backup' } } },
        };
        const { fleet, settled, outcome } = await drive(mod, options);
        return (
          settled &&
          outcome?.status === 'held' &&
          (outcome.detail ?? '').includes('did not answer') &&
          fleet.calls.health === 0
        );
      }
    );
  });

  it('a timed-out bump not aborted applies anyway once its backup finishes', async () => {
    await expectPair(
      {
        file: 'ringController.ts',
        find: "await withDeadline(machine.abort(), deps.deadlines.abortMs, 'saving the abort');",
        replace: '',
      },
      async (mod) => {
        const { fleet, settled } = await drive(mod, {
          tenants: { 'canary-mysql': { stall: { step: 'backup', ms: 20_000 } } },
        });
        await vi.advanceTimersByTimeAsync(30_000);
        const machine = fleet.machines.get('canary-mysql') as BumpStateMachine;
        return settled && machine.getState() === 'cancelled' && fleet.bumpOrder().length === 0;
      }
    );
  });
});

describe('an abort that lands before the migration starts', () => {
  it('cancels a bump whose deadline fires in backed-up, so the migration never runs', async () => {
    // The 'backed-up' write takes 20 s; the bump's bound is 5 s.
    const { fleet, settled, outcome } = await drive(real, {
      store: memoryStore(),
      writeDelay: (tenantId, snapshot) =>
        tenantId === 'canary-mysql' && snapshot.state === 'backed-up' && !snapshot.abortRequested
          ? 20_000
          : undefined,
    });
    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ reason: 'bump-not-done', tenantId: 'canary-mysql' });
    expect((outcome as { detail: string }).detail).toContain("still in 'backed-up'");

    await vi.advanceTimersByTimeAsync(30_000);
    const machine = fleet.machines.get('canary-mysql') as BumpStateMachine;
    expect(machine.getState()).toBe('cancelled');
    expect(fleet.bumpOrder()).toEqual([]);
    expect(fleet.events.filter((e) => e.startsWith('revert:'))).toEqual([]);
  });
});

describe('a timed-out bump abort', () => {
  it('is saved before the release returns, and a restart then never marks the tenant done', async () => {
    const store = memoryStore();
    const { settled, outcome } = await drive(real, {
      store,
      tenants: { 'canary-mysql': { stall: { step: 'apply' } } },
    });
    expect(settled).toBe(true);
    expect((outcome as { detail: string }).detail).toContain(
      "still in 'applying'; abort requested and saved"
    );
    expect(await store.load('canary-mysql')).toMatchObject({
      state: 'applying',
      abortRequested: true,
    });

    // The process dies with the apply still in flight. A new one recovers
    // from the store, and the migration has since settled healthy.
    const reverted: string[] = [];
    const result = await recoverPersistedTenants(store, createApplyLock(), (tenantId) => ({
      backup: async () => ({ ok: true }),
      apply: async () => ({ ok: true }),
      awaitApplySettled: async () => ({ ok: true }),
      verify: async () => ({ ok: true }),
      revertTraffic: async () => {
        reverted.push(tenantId);
        return { ok: true };
      },
      stopColour: async () => undefined,
      page: async () => undefined,
    }));
    expect(result.failed).toEqual([]);
    expect(result.recovered.map((r) => [r.tenantId, r.finalState])).toEqual([
      ['canary-mysql', 'reverted'],
    ]);
    expect(reverted).toEqual(['canary-mysql']);
  });

  it('names a save that does not answer in the hold, and still holds by its bound', async () => {
    const { settled, outcome } = await drive(real, {
      store: memoryStore(),
      tenants: { 'canary-mysql': { stall: { step: 'backup' } } },
      writeDelay: (_tenantId, snapshot) => (snapshot.abortRequested ? 'forever' : undefined),
    });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ reason: 'bump-not-done', tenantId: 'canary-mysql' });
    expect((outcome as { detail: string }).detail).toContain(
      'abort requested but not saved: saving the abort did not answer within 1000ms'
    );
  });
});

describe('the remaining outside calls', () => {
  it('a hung listMembers() holds as probe-failed', async () => {
    const { settled, outcome } = await drive(real, {
      listMembers: (ring) =>
        ring === 'demos'
          ? never()
          : Promise.resolve([{ tenantId: 'canary-mysql', engine: 'mysql' }]),
    });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ at: 'demos', reason: 'probe-failed' });
    expect((outcome as { detail: string }).detail).toContain(
      'listMembers() did not answer within 1000ms'
    );
  });

  it('a hung recordPromotion() holds before the old colour is stopped', async () => {
    const { fleet, settled, outcome } = await drive(real, {
      recordPromotion: (record) => (record.slot === 'demo-1' ? never() : Promise.resolve()),
    });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({
      at: 'demos',
      reason: 'promotion-record-failed',
      tenantId: 'demo-1',
    });
    expect((outcome as { detail: string }).detail).toContain(
      'recordPromotion() did not answer within 1000ms'
    );
    expect(fleet.stoppedOld()).toEqual(['canary-mysql']);
  });

  it('a hung closeBakeWindow() holds as bump-not-done and touches no later ring', async () => {
    const { fleet, settled, outcome } = await drive(real, {
      tenants: { 'demo-1': { stall: { step: 'stopOld' } } },
    });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ at: 'demos', reason: 'bump-not-done', tenantId: 'demo-1' });
    expect((outcome as { detail: string }).detail).toContain(
      'closeBakeWindow() did not answer within 1000ms'
    );
    expect(fleet.bumpOrder()).toEqual(['canary-mysql', 'demo-1']);
  });

  it('a hung revert is named in the regression hold, which is still raised', async () => {
    const { fleet, settled, outcome } = await drive(real, {
      tenants: { 'demo-1': { stall: { step: 'revert' } } },
      health: (tenantId) =>
        Promise.resolve(
          tenantId === 'demo-1' ? { healthy: false } : { healthy: true, reportedDigest: DIGEST }
        ),
    });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ at: 'demos', reason: 'unhealthy', tenantId: 'demo-1' });
    expect((outcome as { detail: string }).detail).toContain(
      'demo-1: revert failed: the revert did not answer within 1000ms'
    );
    expect(fleet.holds).toHaveLength(1);
  });

  it('a hung hold() rejects the release by its bound rather than reporting a hold nobody got', async () => {
    const { settled, error } = await drive(real, {
      runGatesThrows: true,
      hold: () => never(),
    });

    expect(settled).toBe(true);
    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect((error as Error).message).toBe('hold() did not answer within 1000ms');
  });

  it('a bake clock that does not wake holds as probe-failed', async () => {
    const { fleet, settled, outcome } = await drive(real, { sleep: () => never() });

    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ at: 'slot-0', reason: 'probe-failed' });
    expect((outcome as { detail: string }).detail).toContain(
      `clock.sleep() did not answer within ${10_000 + 1_000}ms`
    );
    expect(fleet.stoppedOld()).toEqual([]);
  });
});

describe('sabotage pairs for the remaining calls', () => {
  const pair = async (
    mutation: Mutation,
    scenario: (mod: Module) => Promise<boolean>
  ): Promise<void> => {
    const sabotaged = await importSabotaged<Module>('ringController.ts', [mutation]);
    expect(await scenario(sabotaged)).toBe(false);
    expect(await scenario(real)).toBe(true);
  };

  const heldWith = async (mod: Module, options: FleetOptions, text: string): Promise<boolean> => {
    const { settled, outcome } = await drive(mod, options);
    return settled && outcome?.status === 'held' && (outcome.detail ?? '').includes(text);
  };

  it('an unbounded listMembers() lets a hung member list stall the release', async () => {
    await pair(
      {
        file: 'ringController.ts',
        find: "withDeadline(deps.listMembers(ring), deadlines.listMembersMs, 'listMembers()'),",
        replace: 'deps.listMembers(ring),',
      },
      (mod) =>
        heldWith(
          mod,
          {
            listMembers: (ring) =>
              ring === 'demos'
                ? never()
                : Promise.resolve([{ tenantId: 'canary-mysql', engine: 'mysql' }]),
          },
          'listMembers()'
        )
    );
  });

  it('an unbounded recordPromotion() lets a hung recorder stall the release', async () => {
    await pair(
      {
        file: 'ringController.ts',
        find: "withDeadline(deps.recordPromotion(record), deadlines.recordPromotionMs, 'recordPromotion()'),",
        replace: 'deps.recordPromotion(record),',
      },
      (mod) =>
        heldWith(
          mod,
          { recordPromotion: (record) => (record.slot === 'demo-1' ? never() : Promise.resolve()) },
          'recordPromotion()'
        )
    );
  });

  it('an unbounded closeBakeWindow() lets a hung teardown stall the release', async () => {
    await pair(
      {
        file: 'ringController.ts',
        find: `withDeadline(
        machine.closeBakeWindow(),
        deps.deadlines.closeBakeWindowMs,
        'closeBakeWindow()'
      );`,
        replace: 'machine.closeBakeWindow();',
      },
      (mod) =>
        heldWith(
          mod,
          { tenants: { 'demo-1': { stall: { step: 'stopOld' } } } },
          'closeBakeWindow()'
        )
    );
  });

  it('an unbounded revert lets a hung flag change stall the regression hold', async () => {
    await pair(
      {
        file: 'ringController.ts',
        find: `withDeadline(
        problem.machine.abortAfterDone(),
        deps.deadlines.revertMs,
        'the revert'
      );`,
        replace: 'problem.machine.abortAfterDone();',
      },
      (mod) =>
        heldWith(
          mod,
          {
            tenants: { 'demo-1': { stall: { step: 'revert' } } },
            health: (tenantId) =>
              Promise.resolve(
                tenantId === 'demo-1'
                  ? { healthy: false }
                  : { healthy: true, reportedDigest: DIGEST }
              ),
          },
          'the revert did not answer'
        )
    );
  });

  it('an unbounded hold() lets a hung alert sink stall the release', async () => {
    await pair(
      {
        file: 'ringController.ts',
        find: "hold: (held) => withDeadline(deps.hold(held), deadlines.holdMs, 'hold()'),",
        replace: 'hold: deps.hold,',
      },
      async (mod) => {
        const { settled, error } = await drive(mod, { runGatesThrows: true, hold: () => never() });
        return settled && error instanceof Error && error.message.includes('hold()');
      }
    );
  });

  it('an unbounded clock.sleep() lets a stuck bake clock stall the release', async () => {
    await pair(
      {
        file: 'ringController.ts',
        find: "withDeadline(deps.clock.sleep(ms), ms + deadlines.sleepOverrunMs, 'clock.sleep()'),",
        replace: 'deps.clock.sleep(ms),',
      },
      (mod) => heldWith(mod, { sleep: () => never() }, 'clock.sleep()')
    );
  });

  it('an unbounded abort save lets a hung store stall the release', async () => {
    await pair(
      {
        file: 'ringController.ts',
        find: "await withDeadline(machine.abort(), deps.deadlines.abortMs, 'saving the abort');",
        replace: 'await machine.abort();',
      },
      (mod) =>
        heldWith(
          mod,
          {
            store: memoryStore(),
            tenants: { 'canary-mysql': { stall: { step: 'backup' } } },
            writeDelay: (_tenantId, snapshot) => (snapshot.abortRequested ? 'forever' : undefined),
          },
          'abort requested but not saved'
        )
    );
  });

  it('an abort that is not awaited lets the release return before it is saved', async () => {
    await pair(
      {
        file: 'ringController.ts',
        find: "await withDeadline(machine.abort(), deps.deadlines.abortMs, 'saving the abort');",
        replace: 'void machine.abort();',
      },
      async (mod) => {
        const store = memoryStore();
        const { settled } = await drive(mod, {
          store,
          tenants: { 'canary-mysql': { stall: { step: 'apply' } } },
          // The abort's own write takes 3 s, inside its 10 s bound; the
          // release must not return first.
          deadlines: { ...SHORT, abortMs: 10_000 },
          writeDelay: (_tenantId, snapshot) => (snapshot.abortRequested ? 3_000 : undefined),
        });
        return settled && (await store.load('canary-mysql'))?.abortRequested === true;
      }
    );
  });
});
