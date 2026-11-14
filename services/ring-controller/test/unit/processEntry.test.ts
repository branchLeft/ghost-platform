/**
 * The one entry that reads the process environment hands it to the
 * model-free check as it stands: a key set on the process stops the release
 * even though the caller passes no environment at all.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_ENV_PREFIXES,
  MODEL_ENV_SUFFIXES,
  ModelKeyPresentError,
} from '../../src/modelFreeEnvironment.js';
import * as entry from '../../src/index.js';
import * as real from '../../src/processEntry.js';
import { RELEASE, bakeConfig, makeFleet } from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = { runReleaseFromProcess: typeof real.runReleaseFromProcess };

const KEY = 'ANTHROPIC_API_KEY';
const SECRET = 'sk-test-not-real';

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupSabotageTmp();
});

/**
 * Clears whatever the machine running the tests holds (a developer's shell
 * may carry vendor variables, or an agent binary on PATH), then sets the one
 * key under test, so a refusal can only be about that key.
 */
function stubOnlyTheKey(): void {
  for (const name of Object.keys(process.env)) {
    const upper = name.toUpperCase();
    if (
      MODEL_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix)) ||
      MODEL_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
    ) {
      vi.stubEnv(name, undefined);
    }
  }
  vi.stubEnv('PATH', '/nonexistent-ring-controller-test-path');
  vi.stubEnv(KEY, SECRET);
}

/** True when the entry refused, before any gate ran, because of a key set only on the process. */
async function refusesProcessKey(mod: Module): Promise<boolean> {
  stubOnlyTheKey();
  const fleet = makeFleet();
  try {
    await mod.runReleaseFromProcess(RELEASE, fleet.deps, bakeConfig());
    return false;
  } catch (err) {
    return (
      err instanceof Error &&
      err.name === 'ModelKeyPresentError' &&
      err.message.includes(KEY) &&
      fleet.calls.runGates === 0 &&
      fleet.calls.newBump === 0
    );
  } finally {
    vi.unstubAllEnvs();
  }
}

describe('runReleaseFromProcess', () => {
  it('refuses a model key set on the process, naming it and never its value', async () => {
    stubOnlyTheKey();
    const fleet = makeFleet();

    const settled = await real.runReleaseFromProcess(RELEASE, fleet.deps, bakeConfig()).then(
      () => undefined,
      (err: unknown) => err
    );

    expect(settled).toBeInstanceOf(ModelKeyPresentError);
    expect((settled as Error).message).toContain(KEY);
    expect((settled as Error).message).not.toContain(SECRET);
    expect(fleet.calls.runGates).toBe(0);
    expect(fleet.holds).toEqual([]);
  });

  it('is the only release entry the package exports, so no caller can pass its own environment', () => {
    expect(entry.runReleaseFromProcess).toBe(real.runReleaseFromProcess);
    expect(Object.keys(entry)).not.toContain('runRelease');
  });

  it('reads the environment at call time, not when the module was loaded', async () => {
    expect(await refusesProcessKey(real)).toBe(true);
  });

  const sabotages: [string, Mutation][] = [
    ['an empty environment', { file: 'processEntry.ts', find: 'process.env)', replace: '{})' }],
    [
      'a scrubbed copy',
      {
        file: 'processEntry.ts',
        find: 'process.env)',
        replace: `Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ANTHROPIC_'))))`,
      },
    ],
  ];

  it.each(sabotages)('sabotage pair: passing %s lets the key through', async (_name, mutation) => {
    const sabotaged = await importSabotaged<Module>('processEntry.ts', [mutation]);

    expect(await refusesProcessKey(sabotaged)).toBe(false);
    expect(await refusesProcessKey(real)).toBe(true);
  });
});
