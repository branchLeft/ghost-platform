/**
 * A refusal on the unattended path is raised through the hold sink without
 * going through `runRelease`, so the sink's time limit has to hold here too:
 * a hung sink rejects the call by `holdMs` rather than stalling it, and a
 * hold nobody received is never reported as raised. Paired with a one-line
 * sabotage of the real source.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeadlineExceededError } from '../../src/deadlines.js';
import { UNATTENDED_MINOR_FLAG } from '../../src/minorEligibility.js';
import type { Release } from '../../src/ringController.js';
import * as real from '../../src/unattendedMinor.js';
import { CLEAN_ENV, DIGEST, bakeConfig, makeFleet } from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = { runUnattendedMinor: typeof real.runUnattendedMinor };

const FLAG_ON = Object.freeze({ [UNATTENDED_MINOR_FLAG]: 'on' });
const MAJOR: Release = { digest: DIGEST, version: '7.0.0', route: 'fast-path' };
const HOLD_MS = 1_000;

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  cleanupSabotageTmp();
});

/** A major is refused before any gate runs, so the only outside call is the hold sink, which hangs. */
async function hungRefusalHold(mod: Module, deadlines?: { holdMs: number }) {
  const fleet = makeFleet({ hold: () => never(), ...(deadlines ? { deadlines } : {}) });
  let settled = false;
  let error: unknown;
  mod
    .runUnattendedMinor(
      { release: MAJOR, currentVersion: '6.55.0', restoreDrill: undefined },
      fleet.deps,
      bakeConfig(),
      FLAG_ON
    )
    .then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        settled = true;
        error = err;
      }
    );
  await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
  const early = settled;
  await vi.advanceTimersByTimeAsync(2);
  return { early, atLimit: settled, error, fleet };
}

const HOLD_LIMIT: Mutation = {
  file: 'unattendedMinor.ts',
  find: "await withDeadline(deps.hold(held), holdMs, 'hold()');",
  replace: 'await deps.hold(held);',
};

describe('runUnattendedMinor -- the hold sink has a limit', () => {
  it('a hung sink rejects the refusal by holdMs, not a hold nobody received', async () => {
    const { early, atLimit, error, fleet } = await hungRefusalHold(real, { holdMs: HOLD_MS });

    expect(early).toBe(false);
    expect(atLimit).toBe(true);
    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect((error as Error).message).toBe('hold() did not answer within 1000ms');
    expect(fleet.calls.runGates).toBe(0);
    expect(fleet.calls.newBump).toBe(0);
  });

  it('without the limit, a hung sink stalls the refusal for ever', async () => {
    const mod = await importSabotaged<Module>('unattendedMinor.ts', [HOLD_LIMIT]);
    expect((await hungRefusalHold(mod, { holdMs: HOLD_MS })).atLimit).toBe(false);
    expect((await hungRefusalHold(real, { holdMs: HOLD_MS })).atLimit).toBe(true);
  });

  it('a sink that answers in time is not cut off', async () => {
    const fleet = makeFleet({ deadlines: { holdMs: HOLD_MS } });
    const outcome = await real.runUnattendedMinor(
      { release: MAJOR, currentVersion: '6.55.0', restoreDrill: undefined },
      fleet.deps,
      bakeConfig(),
      FLAG_ON
    );
    expect(outcome).toMatchObject({ status: 'held', at: 'preflight' });
    expect(fleet.holds).toHaveLength(1);
  });
});

describe('runUnattendedMinor -- a flag-off decline is not bounded or held', () => {
  it('declines without reading the deadlines', async () => {
    const fleet = makeFleet({ deadlines: { holdMs: -1 } });
    const outcome = await real.runUnattendedMinor(
      { release: MAJOR, currentVersion: '6.55.0', restoreDrill: undefined },
      fleet.deps,
      bakeConfig(),
      CLEAN_ENV
    );
    expect(outcome).toEqual({ status: 'declined', reason: 'flag-off' });
  });
});
