/**
 * Sabotage pairs. Each one breaks a real line of `src/` in a throwaway copy,
 * asserts the property FAILS on that copy, then asserts it HOLDS on the real
 * module. A property that held on both would prove nothing about the line.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as real from '../../src/ringController.js';
import type { Release } from '../../src/ringController.js';
import {
  BAKE_MS,
  CLEAN_ENV,
  DIGEST,
  OLD_DIGEST,
  RELEASE,
  bakeConfig,
  makeFleet,
  type FleetOptions,
} from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = { runRelease: typeof real.runRelease };

afterAll(() => {
  cleanupSabotageTmp();
});

const sabotaged = (...mutations: Mutation[]) =>
  importSabotaged<Module>('ringController.ts', mutations);

async function drive(
  mod: Module,
  options: FleetOptions = {},
  env: Readonly<Record<string, string | undefined>> = CLEAN_ENV,
  release: Release = RELEASE
) {
  const fleet = makeFleet(options);
  const settled = await mod.runRelease(release, fleet.deps, bakeConfig(), env).then(
    (outcome) => ({ outcome, error: undefined as unknown }),
    (error: unknown) => ({ outcome: undefined, error })
  );
  return { fleet, ...settled };
}

/** The pair: `holds` is false on the sabotaged copy and true on the real module. */
async function expectPair(
  mutations: Mutation[],
  scenario: (mod: Module) => Promise<boolean>
): Promise<void> {
  expect(await scenario(await sabotaged(...mutations))).toBe(false);
  expect(await scenario(real)).toBe(true);
}

const reorderRings: Mutation = {
  file: 'rings.ts',
  find: "['slot-0', 'demos', 'entry', 'professional']",
  replace: "['demos', 'slot-0', 'entry', 'professional']",
};

const parallelBumps: Mutation = {
  file: 'ringController.ts',
  find: `  for (const member of members) {
    const outcome = await bumpOne(member, release, deps);
    outcomes.push(outcome);
    if (outcome.state !== 'done') break;
  }`,
  replace:
    '  outcomes.push(...(await Promise.all(members.map((member) => bumpOne(member, release, deps)))));',
};

const timerOnly: Mutation = {
  file: 'ringController.ts',
  find: 'const problems = await probeRing(bumped, release, deps, ringStartedAt);',
  replace: 'const problems: Problem[] = [];',
};

const firstMemberOnly: Mutation = {
  file: 'ringController.ts',
  find: 'const problem = await probeMember(member.tenantId, machine, release, deps, ringStartedAt);',
  replace:
    'const problem = member.tenantId === bumped[0]?.member.tenantId ? await probeMember(member.tenantId, machine, release, deps, ringStartedAt) : undefined;',
};

const noMysqlPredicate: Mutation = {
  file: 'ringController.ts',
  find: 'if (ring === MYSQL_GATED_RING && !mysqlCanaryReady) {',
  replace: 'if (false) {',
};

const noGateCheck: Mutation = {
  file: 'ringController.ts',
  find: 'if (!verdict.ok) {',
  replace: 'if (false) {',
};

const noDigestCheck: Mutation = {
  file: 'gates.ts',
  find: 'release.digest.length === 0 || report.digest !== release.digest',
  replace: 'false',
};

const noModelRefusal: Mutation = {
  file: 'modelFreeEnvironment.ts',
  find: 'if (value !== undefined && isModelVariable(name)) {',
  replace: 'if (false) {',
};

const noEmptyRingBake: Mutation = {
  file: 'ringController.ts',
  find: 'const endAt = bakeStartedAt + bake.bakeMs;',
  replace: 'const endAt = bakeStartedAt + (bumped.length === 0 ? 0 : bake.bakeMs);',
};

const silentlyUnhealthy: FleetOptions = {
  health: (tenantId) => ({ healthy: tenantId !== 'entry-2', reportedDigest: DIGEST }),
};

describe('sabotage: the ring order', () => {
  it('reordering RING_ORDER breaks the order; the real order holds', async () => {
    await expectPair([reorderRings], async (mod) => {
      const { fleet } = await drive(mod);
      return fleet.ringsInBumpOrder().join() === 'slot-0,demos,entry,professional';
    });
  });
});

describe('sabotage: serial within a ring', () => {
  it('bumping a ring with Promise.all puts two run() calls in flight; the loop holds one', async () => {
    await expectPair([parallelBumps], async (mod) => {
      const { fleet } = await drive(mod);
      return fleet.counter.highWater === 1;
    });
  });
});

describe('sabotage: the bake is not the timer alone', () => {
  it('dropping the end-of-bake probe promotes a silently unhealthy tenant; the real one holds', async () => {
    await expectPair([timerOnly], async (mod) => {
      const { outcome, fleet } = await drive(mod, silentlyUnhealthy);
      return (
        outcome?.status === 'held' &&
        outcome.reason === 'unhealthy' &&
        !fleet.bumpOrder().includes('pro-1')
      );
    });
  });

  it('probing only the first member lets the silently unhealthy second one through; the real one holds', async () => {
    await expectPair([firstMemberOnly], async (mod) => {
      const { outcome } = await drive(mod, silentlyUnhealthy);
      return outcome?.status === 'held' && outcome.tenantId === 'entry-2';
    });
  });
});

describe('sabotage: ring 0 must include MySQL (U6)', () => {
  it('removing the predicate promotes a SQLite-only ring 0 into ring 2; the real one holds', async () => {
    const sqliteOnly: FleetOptions = {
      members: { 'slot-0': [{ tenantId: 'canary-sqlite', engine: 'sqlite' }] },
    };
    await expectPair([noMysqlPredicate], async (mod) => {
      const { outcome, fleet } = await drive(mod, sqliteOnly);
      return (
        outcome?.status === 'held' &&
        outcome.reason === 'no-mysql-in-ring-0' &&
        !fleet.bumpOrder().includes('entry-1')
      );
    });
  });
});

describe('sabotage: the gates', () => {
  const redGate: FleetOptions = {
    gates: (digest) => ({ digest, results: [{ name: 'migrations', ok: false }] }),
  };

  it('removing the gate check bumps tenants on a red gate; the real one bumps none', async () => {
    await expectPair([noGateCheck], async (mod) => {
      const { outcome, fleet } = await drive(mod, redGate);
      return (
        outcome?.status === 'held' && outcome.reason === 'gate-red' && fleet.calls.newBump === 0
      );
    });
  });

  it('removing the digest check accepts a green report for another digest; the real one refuses', async () => {
    const stale: FleetOptions = {
      gates: () => ({ digest: OLD_DIGEST, results: [{ name: 'smoke', ok: true }] }),
    };
    await expectPair([noDigestCheck], async (mod) => {
      const { outcome, fleet } = await drive(mod, stale);
      return (
        outcome?.status === 'held' &&
        outcome.reason === 'gate-digest-mismatch' &&
        fleet.calls.newBump === 0
      );
    });
  });
});

describe('sabotage: no model in the path (D37)', () => {
  it('removing the refusal lets a run proceed with a model key set; the real one refuses', async () => {
    await expectPair([noModelRefusal], async (mod) => {
      const { error, fleet } = await drive(mod, {}, { ANTHROPIC_API_KEY: 'sk-test-not-real' });
      return (
        (error as Error | undefined)?.name === 'ModelKeyPresentError' && fleet.calls.runGates === 0
      );
    });
  });
});

describe('sabotage: an empty ring still bakes', () => {
  it('skipping the bake on an empty ring moves on at once; the real one waits the window out', async () => {
    await expectPair([noEmptyRingBake], async (mod) => {
      const seen: Record<string, number> = {};
      let fleet!: ReturnType<typeof makeFleet>;
      const outcome = await (async () => {
        fleet = makeFleet({
          members: { demos: [] },
          listMembers: async (ring) => {
            seen[ring] = fleet.nowMs();
            return fleet.members[ring];
          },
        });
        return mod.runRelease(RELEASE, fleet.deps, bakeConfig(), CLEAN_ENV);
      })();
      return (
        outcome.status === 'completed' &&
        (seen['entry'] as number) - (seen['demos'] as number) >= BAKE_MS
      );
    });
  });
});

describe('sabotage: the headline safety property', () => {
  it('refuses to promote on a red gate with every key and agent binary absent, and refuses a key present', async () => {
    const both = await sabotaged(noGateCheck, noModelRefusal);
    const red: FleetOptions = {
      gates: (digest) => ({ digest, results: [{ name: 'smoke', ok: false }] }),
    };

    // Every key and agent binary absent, one gate red: the real controller promotes nothing...
    const onReal = await drive(real, red, CLEAN_ENV);
    expect(onReal.outcome).toMatchObject({ status: 'held', reason: 'gate-red' });
    expect(onReal.fleet.calls.newBump).toBe(0);
    // ...and with the gate check broken it bumps the fleet on the same red gate.
    const onBroken = await drive(both, red, CLEAN_ENV);
    expect(onBroken.fleet.calls.newBump).toBeGreaterThan(0);
    expect(onBroken.outcome).toMatchObject({ status: 'completed' });

    // A key present: the real controller refuses; with the refusal broken it runs on.
    const keyed = { OPENAI_API_KEY: 'sk-test-not-real' };
    const refused = await drive(real, {}, keyed);
    expect((refused.error as Error).name).toBe('ModelKeyPresentError');
    expect(refused.fleet.calls.runGates).toBe(0);
    const ranOn = await drive(both, {}, keyed);
    expect(ranOn.error).toBeUndefined();
    expect(ranOn.fleet.calls.runGates).toBe(1);
  });
});
