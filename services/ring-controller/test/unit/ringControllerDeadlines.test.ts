/**
 * Every outside call `runRelease` awaits has a deadline, and a call that
 * misses it fails its member (a hold), never passes it and never stalls the
 * release. Driven with fake timers: a hung host is a promise that never
 * settles, and time is advanced until the release settles or the budget
 * runs out.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BumpStateMachine } from '../../src/bumpStateMachine.js';
import { DEFAULT_CALL_DEADLINES, type CallDeadlines } from '../../src/deadlines.js';
import * as real from '../../src/ringController.js';
import type { Health, ReleaseOutcome } from '../../src/ringController.js';
import {
  CLEAN_ENV,
  DIGEST,
  RELEASE,
  bakeConfig,
  makeFleet,
  type FleetOptions,
} from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = { runRelease: typeof real.runRelease };

const SHORT: Partial<CallDeadlines> = {
  runGatesMs: 5_000,
  bumpMs: 5_000,
  healthMs: 1_000,
  reportedErrorsMs: 1_000,
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
      "the bump did not answer within 5000ms, still in 'backing-up'; abort requested"
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
      { file: 'ringController.ts', find: '      machine.abort();\n', replace: '' },
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
