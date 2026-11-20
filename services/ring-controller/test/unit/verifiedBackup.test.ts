import { describe, expect, it, vi } from 'vitest';
import { createApplyLock } from '../../src/applyLock.js';
import {
  BumpStateMachine,
  type BumpDependencies,
  type StepResult,
} from '../../src/bumpStateMachine.js';
import {
  createVerifiedBackup,
  type TakeTenantDump,
  type TenantDumpResult,
} from '../../src/verifiedBackup.js';

const TENANT = 'tenant-a';

/** A dump the worker would call verified. */
export const goodDump = (overrides: Partial<TenantDumpResult> = {}): TenantDumpResult => ({
  tenant: TENANT,
  ok: true,
  exitCode: 0,
  floorTablesSeen: ['posts', 'users'],
  missingFloorTables: [],
  copiesWritten: ['copy-1'],
  error: null,
  ...overrides,
});

function bumpWith(takeDump: TakeTenantDump) {
  const ok: StepResult = { ok: true };
  const deps: BumpDependencies = {
    backup: createVerifiedBackup(TENANT, takeDump),
    apply: vi.fn(async () => ok),
    awaitApplySettled: vi.fn(async () => ok),
    verify: vi.fn(async () => ok),
    revertTraffic: vi.fn(async () => ok),
    stopColour: vi.fn(async () => undefined),
    page: vi.fn(async () => undefined),
  };
  return { deps, machine: new BumpStateMachine(deps, createApplyLock(), { bumpId: 'b1' }) };
}

describe('verified backup -- no verified backup, no bump', () => {
  it('asks for a dump of exactly the one tenant and bumps on a floor-verified result', async () => {
    const takeDump = vi.fn(async () => goodDump());
    const { deps, machine } = bumpWith(takeDump);

    expect(await machine.run()).toBe('done');

    expect(takeDump).toHaveBeenCalledExactlyOnceWith(TENANT);
    expect(deps.apply).toHaveBeenCalledTimes(1);
  });

  it('a dump that exits 0 but misses a floor table is not a backup: no bump', async () => {
    const { deps, machine } = bumpWith(async () =>
      goodDump({ exitCode: 0, missingFloorTables: ['posts'], floorTablesSeen: ['users'] })
    );

    expect(await machine.run()).toBe('backup-failed');

    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.page).not.toHaveBeenCalled();
  });

  it('a dump that exits 0 having seen no floor table at all is not a backup', async () => {
    const { deps, machine } = bumpWith(async () => goodDump({ floorTablesSeen: [] }));

    expect(await machine.run()).toBe('backup-failed');
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('a dump the worker reports not ok is not a backup, whatever its floor says', async () => {
    const { deps, machine } = bumpWith(async () =>
      goodDump({ ok: false, exitCode: 0, error: 'age failed' })
    );

    expect(await machine.run()).toBe('backup-failed');
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('a verified dump with a nonzero exit code is judged by the floor, not the code', async () => {
    const result = await createVerifiedBackup(TENANT, async () => goodDump({ exitCode: 3 }))();

    expect(result).toEqual({ ok: true });
  });

  it('a dump with no stored copy is not a backup', async () => {
    const { deps, machine } = bumpWith(async () => goodDump({ copiesWritten: [] }));

    expect(await machine.run()).toBe('backup-failed');
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it("another tenant's dump is not this tenant's backup", async () => {
    const { deps, machine } = bumpWith(async () => goodDump({ tenant: 'tenant-b' }));

    expect(await machine.run()).toBe('backup-failed');
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('a dump that throws stops cleanly at backup-failed, never a thrown bump', async () => {
    const { deps, machine } = bumpWith(async () => {
      throw new Error('worker unreachable');
    });

    expect(await machine.run()).toBe('backup-failed');
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it('a malformed floor result fails closed', async () => {
    const malformed = { tenant: TENANT, ok: true, exitCode: 0 } as unknown as TenantDumpResult;
    const { deps, machine } = bumpWith(async () => malformed);

    expect(await machine.run()).toBe('backup-failed');
    expect(deps.apply).not.toHaveBeenCalled();
  });
});
