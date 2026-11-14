/**
 * Sabotage pairs for the unattended minor path. Each breaks one real line of
 * `src/` in a throwaway copy, asserts the property FAILS there, then asserts
 * it HOLDS on the real module. A property that held on both would prove
 * nothing about the line.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { UNATTENDED_MINOR_FLAG } from '../../src/minorEligibility.js';
import type { RestoreDrillRecord } from '../../src/minorEligibility.js';
import type { Release } from '../../src/ringController.js';
import * as real from '../../src/unattendedMinor.js';
import { CLEAN_ENV, DIGEST, bakeConfig, makeFleet } from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = { runUnattendedMinor: typeof real.runUnattendedMinor };

afterAll(() => {
  cleanupSabotageTmp();
});

const sabotaged = (...mutations: Mutation[]) =>
  importSabotaged<Module>('unattendedMinor.ts', mutations);

const FLAG_ON = Object.freeze({ [UNATTENDED_MINOR_FLAG]: 'on' });
const MINOR: Release = { digest: DIGEST, version: '6.58.0', route: 'fast-path' };

interface Scenario {
  env?: Readonly<Record<string, string | undefined>>;
  release?: Release;
  /** Built from the fleet's clock, so a record can be a minute, or a year, old. */
  drill?: (nowMs: number) => RestoreDrillRecord | undefined;
}

const aMinuteAgo = (nowMs: number): RestoreDrillRecord => ({
  result: 'pass',
  finishedAtMs: nowMs - 60_000,
});

async function drive(mod: Module, scenario: Scenario) {
  const fleet = makeFleet();
  const outcome = await mod.runUnattendedMinor(
    {
      release: scenario.release ?? MINOR,
      currentVersion: '6.55.0',
      restoreDrill: (scenario.drill ?? aMinuteAgo)(fleet.nowMs()),
    },
    fleet.deps,
    bakeConfig(),
    scenario.env ?? FLAG_ON
  );
  return { fleet, outcome };
}

/** The pair: the property is false on the sabotaged copy and true on the real module. */
async function expectPair(
  mutations: Mutation[],
  scenario: (mod: Module) => Promise<boolean>
): Promise<void> {
  expect(await scenario(await sabotaged(...mutations))).toBe(false);
  expect(await scenario(real)).toBe(true);
}

const alwaysOn: Mutation = {
  file: 'minorEligibility.ts',
  find: 'return env[UNATTENDED_MINOR_FLAG] === UNATTENDED_MINOR_ON;',
  replace: "return env[UNATTENDED_MINOR_FLAG] !== 'off';",
};

const ignoreFlag: Mutation = {
  file: 'minorEligibility.ts',
  find: 'if (!input.enabled) {',
  replace: 'if (false) {',
};

const ignoreDrill: Mutation = {
  file: 'minorEligibility.ts',
  find: 'if (!restoreDrillMet(input.restoreDrill, input.nowMs, input.maxDrillAgeMs)) {',
  replace: 'if (false) {',
};

const ignoreDrillResult: Mutation = {
  file: 'minorEligibility.ts',
  find: "if (drill === undefined || drill.result !== 'pass') {",
  replace: 'if (drill === undefined) {',
};

const ignoreDrillAge: Mutation = {
  file: 'minorEligibility.ts',
  find: 'return age >= 0 && age <= maxAgeMs;',
  replace: 'return age >= 0;',
};

const acceptFutureDrill: Mutation = {
  file: 'minorEligibility.ts',
  find: 'return age >= 0 && age <= maxAgeMs;',
  replace: 'return age <= maxAgeMs;',
};

const readMajorAsMinor: Mutation[] = [
  {
    file: 'minorEligibility.ts',
    find: 'if (target.major > current.major) {',
    replace: 'if (false) {',
  },
  {
    file: 'minorEligibility.ts',
    find: 'target.major === current.major &&\n    (target.minor',
    replace: '(target.minor',
  },
];

describe('sabotage: the flag defaults to off', () => {
  it('reading an absent flag as on runs the fleet with no flag set; the real one declines', async () => {
    await expectPair([alwaysOn], async (mod) => {
      const { outcome, fleet } = await drive(mod, { env: CLEAN_ENV });
      return outcome.status === 'declined' && fleet.calls.newBump === 0;
    });
  });

  it('not checking the flag runs a release with the flag off; the real one declines', async () => {
    await expectPair([ignoreFlag], async (mod) => {
      const { outcome, fleet } = await drive(mod, { env: CLEAN_ENV });
      return outcome.status === 'declined' && fleet.calls.runGates === 0;
    });
  });
});

describe('sabotage: refuses while the restore-drill precondition is unmet', () => {
  it('skipping the drill check bumps tenants with no drill on record; the real one holds', async () => {
    await expectPair([ignoreDrill], async (mod) => {
      const { outcome, fleet } = await drive(mod, { drill: () => undefined });
      return (
        outcome.status === 'held' &&
        outcome.reason === 'restore-drill-unmet' &&
        fleet.calls.newBump === 0
      );
    });
  });

  it('accepting a failed drill bumps tenants; the real one holds', async () => {
    await expectPair([ignoreDrillResult], async (mod) => {
      const { outcome, fleet } = await drive(mod, {
        drill: (nowMs) => ({ result: 'fail', finishedAtMs: nowMs - 1 }),
      });
      return (
        outcome.status === 'held' &&
        outcome.reason === 'restore-drill-unmet' &&
        fleet.calls.newBump === 0
      );
    });
  });

  it('ignoring the age of the drill accepts a year-old pass; the real one holds', async () => {
    await expectPair([ignoreDrillAge], async (mod) => {
      const { outcome, fleet } = await drive(mod, {
        drill: (nowMs) => ({ result: 'pass', finishedAtMs: nowMs - 365 * 24 * 60 * 60 * 1000 }),
      });
      return (
        outcome.status === 'held' &&
        outcome.reason === 'restore-drill-unmet' &&
        fleet.calls.newBump === 0
      );
    });
  });

  it('accepting a future-dated drill bumps tenants; the real one holds', async () => {
    await expectPair([acceptFutureDrill], async (mod) => {
      const { outcome, fleet } = await drive(mod, {
        drill: (nowMs) => ({ result: 'pass', finishedAtMs: nowMs + 60_000 }),
      });
      return (
        outcome.status === 'held' &&
        outcome.reason === 'restore-drill-unmet' &&
        fleet.calls.newBump === 0
      );
    });
  });
});

describe('sabotage: a major is never taken unattended', () => {
  it('reading a major as a minor bumps tenants on a fast-path 7.x; the real one holds', async () => {
    await expectPair(readMajorAsMinor, async (mod) => {
      const { outcome, fleet } = await drive(mod, {
        release: { ...MINOR, version: '7.60.0' },
      });
      return (
        outcome.status === 'held' &&
        outcome.reason === 'consent-required' &&
        fleet.calls.runGates === 0 &&
        fleet.calls.newBump === 0
      );
    });
  });
});
