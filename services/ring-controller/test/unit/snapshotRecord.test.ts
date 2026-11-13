/**
 * What turns a state-machine snapshot into a saved tenant record keeps
 * `abortRequested`. Lose it and a restart finishes a tenant the crashed
 * process had already given up on, with nobody to watch its bake.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as real from '../../src/index.js';
import type { BumpDependencies, PersistSnapshot } from '../../src/index.js';
import { memoryStore } from './helpers/fakeFleet.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = Pick<
  typeof real,
  | 'BumpStateMachine'
  | 'createApplyLock'
  | 'persistToStore'
  | 'recordFromSnapshot'
  | 'recoverPersistedTenants'
>;

afterAll(() => {
  cleanupSabotageTmp();
});

const TENANT = 'tenant-a';
const NOW = '2026-11-13T00:00:00.000Z';

const SNAPSHOT: PersistSnapshot = {
  state: 'done',
  pageSent: false,
  abortRequested: true,
  bumpId: 'bump-a',
};

function fakeDeps(
  calls: { revert: number },
  overrides: Partial<BumpDependencies> = {}
): BumpDependencies {
  return {
    backup: async () => ({ ok: true }),
    apply: async () => ({ ok: true }),
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

/** A tenant run to `done`, aborted, then restarted from whatever the adapter saved. */
async function abortedDoneAfterRestart(mod: Module): Promise<string | undefined> {
  const store = memoryStore();
  const machine = new mod.BumpStateMachine(
    fakeDeps({ revert: 0 }, { persist: mod.persistToStore(store, TENANT, () => NOW) }),
    mod.createApplyLock(),
    { bumpId: 'bump-a' }
  );
  await machine.run();
  await machine.abort();
  const calls = { revert: 0 };
  const { recovered } = await mod.recoverPersistedTenants(store, mod.createApplyLock(), () =>
    fakeDeps(calls)
  );
  return recovered[0]?.finalState;
}

const sabotaged = (mutation: Mutation): Promise<Module> =>
  importSabotaged<Module>('index.ts', [mutation]);

const DROP_ABORT: Mutation = {
  file: 'tenantStateStore.ts',
  find: '    abortRequested: snapshot.abortRequested,\n',
  replace: '',
};

describe('the snapshot-to-record adapter keeps abortRequested', () => {
  it.each([true, false])('recordFromSnapshot carries abortRequested: %s', (abortRequested) => {
    expect(real.recordFromSnapshot(TENANT, { ...SNAPSHOT, abortRequested }, NOW)).toEqual({
      tenantId: TENANT,
      state: 'done',
      pageSent: false,
      abortRequested,
      bumpId: 'bump-a',
      reason: undefined,
      updatedAt: NOW,
    });
  });

  it('persistToStore saves the abort, and a restart reverts the aborted done tenant', async () => {
    const store = memoryStore();
    await real.persistToStore(store, TENANT, () => NOW)(SNAPSHOT);
    expect(await store.load(TENANT)).toMatchObject({ abortRequested: true, updatedAt: NOW });

    expect(await abortedDoneAfterRestart(real)).toBe('reverted');
  });

  it('an adapter that drops abortRequested leaves the aborted tenant on the new version', async () => {
    const mod = await sabotaged(DROP_ABORT);

    const store = memoryStore();
    await mod.persistToStore(store, TENANT, () => NOW)(SNAPSHOT);
    expect((await store.load(TENANT))?.abortRequested).toBeUndefined();

    expect(await abortedDoneAfterRestart(mod)).toBe('done');
    expect(await abortedDoneAfterRestart(real)).toBe('reverted');
  });
});
