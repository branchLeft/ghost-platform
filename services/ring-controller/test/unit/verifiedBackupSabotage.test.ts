/**
 * Sabotage pairs for "no verified backup, no bump". Each breaks one real
 * line of `src/verifiedBackup.ts` in a throwaway copy, asserts the property
 * FAILS there, then asserts it HOLDS on the real module. A property that held
 * on both would prove nothing about the line.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createApplyLock } from '../../src/applyLock.js';
import { BumpStateMachine, type BumpState } from '../../src/bumpStateMachine.js';
import * as real from '../../src/verifiedBackup.js';
import type { TenantDumpResult } from '../../src/verifiedBackup.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = { createVerifiedBackup: typeof real.createVerifiedBackup };

afterAll(() => {
  cleanupSabotageTmp();
});

const sabotaged = (...mutations: Mutation[]) =>
  importSabotaged<Module>('verifiedBackup.ts', mutations);

const TENANT = 'tenant-a';

const goodDump = (overrides: Partial<TenantDumpResult> = {}): TenantDumpResult => ({
  tenant: TENANT,
  ok: true,
  exitCode: 0,
  floorTablesSeen: ['posts', 'users'],
  missingFloorTables: [],
  copiesWritten: ['copy-1'],
  error: null,
  ...overrides,
});

/** Runs a whole bump on `dump`, returning where it ended and whether the migration ran. */
async function bump(mod: Module, dump: () => Promise<TenantDumpResult>) {
  let applied = false;
  const ok = { ok: true };
  const machine = new BumpStateMachine(
    {
      backup: mod.createVerifiedBackup(TENANT, dump),
      apply: async () => {
        applied = true;
        return ok;
      },
      awaitApplySettled: async () => ok,
      verify: async () => ok,
      revertTraffic: async () => ok,
      stopColour: async () => undefined,
      page: async () => undefined,
    },
    createApplyLock(),
    { bumpId: 'b1' }
  );
  const state: BumpState = await machine.run();
  return { state, applied };
}

/** The pair: the bump is refused on the real module, and goes ahead on the sabotaged copy. */
async function expectPair(
  mutations: Mutation[],
  dump: () => Promise<TenantDumpResult>
): Promise<void> {
  const broken = await bump(await sabotaged(...mutations), dump);
  expect(broken.applied).toBe(true); // the sabotaged copy migrates on an untrusted dump
  const held = await bump(real, dump);
  expect(held).toEqual({ state: 'backup-failed', applied: false });
}

const trustExitCode: Mutation = {
  file: 'verifiedBackup.ts',
  find: 'if (!Array.isArray(missing) || missing.length > 0) {',
  replace: 'if (result.exitCode !== 0) {',
};

describe('no verified backup, no bump -- sabotage pairs', () => {
  it('trusting the exit code instead of the floor lets a floor-missing dump through', async () => {
    await expectPair(
      [
        trustExitCode,
        {
          file: 'verifiedBackup.ts',
          find: 'result.floorTablesSeen.length === 0',
          replace: 'false',
        },
      ],
      async () => goodDump({ exitCode: 0, missingFloorTables: ['posts'], floorTablesSeen: [] })
    );
  });

  it('dropping the vacuous-floor check lets a dump that saw no floor table through', async () => {
    await expectPair(
      [
        {
          file: 'verifiedBackup.ts',
          find: 'result.floorTablesSeen.length === 0',
          replace: 'false',
        },
      ],
      async () => goodDump({ floorTablesSeen: [] })
    );
  });

  it('dropping the ok check lets a dump the worker rejected through', async () => {
    await expectPair(
      [{ file: 'verifiedBackup.ts', find: 'if (!result.ok) {', replace: 'if (false) {' }],
      async () => goodDump({ ok: false, error: 'age failed' })
    );
  });

  it('dropping the stored-copy check lets a dump nobody stored through', async () => {
    await expectPair(
      [{ file: 'verifiedBackup.ts', find: 'result.copiesWritten.length === 0', replace: 'false' }],
      async () => goodDump({ copiesWritten: [] })
    );
  });

  it("dropping the tenant check lets another tenant's dump through", async () => {
    await expectPair(
      [{ file: 'verifiedBackup.ts', find: 'result.tenant !== tenantId', replace: 'false' }],
      async () => goodDump({ tenant: 'tenant-b' })
    );
  });

  it('turning a throwing dump into a pass lets an unreachable worker through', async () => {
    await expectPair(
      [
        {
          file: 'verifiedBackup.ts',
          find: "return { ok: false, reason: err instanceof Error ? err.message : 'the dump threw' };",
          replace: 'void err; return { ok: true };',
        },
      ],
      async () => {
        throw new Error('worker unreachable');
      }
    );
  });
});
