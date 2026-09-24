import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { writeLeaseAndHash, type LeaseStoreConfig } from '../../src/leaseStore.js';
import { readSlotState, recoverCrashedSlots, writeSlotState } from '../../src/stateStore.js';

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

describe('stateStore', () => {
  let dir: string;
  let leaseStoreConfig: Pick<LeaseStoreConfig, 'slotsPath' | 'leaseDir'>;

  beforeEach(async () => {
    dir = await makeTempDir('broker-statestore-');
    const root = await makeTempDir('broker-statestore-lease-');
    leaseStoreConfig = { slotsPath: join(root, 'slots.json'), leaseDir: root };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(leaseStoreConfig.leaseDir, { recursive: true, force: true });
  });

  it('reads "free" for a slot with no state file yet', async () => {
    expect(await readSlotState(dir, '0' as SlotName)).toEqual({ phase: 'free' });
  });

  it('round-trips a running state with colour and descriptorHash', async () => {
    const slot = '2' as SlotName;
    await writeSlotState(dir, slot, { phase: 'running', colour: 'b', descriptorHash: 'abc123' });
    expect(await readSlotState(dir, slot)).toEqual({
      phase: 'running',
      colour: 'b',
      descriptorHash: 'abc123',
    });
  });

  it('one slot writing state does not affect another slot', async () => {
    await writeSlotState(dir, '0' as SlotName, {
      phase: 'running',
      colour: 'a',
      descriptorHash: 'h0',
    });
    expect(await readSlotState(dir, '1' as SlotName)).toEqual({ phase: 'free' });
  });

  it('overwrites the previous state for the same slot', async () => {
    const slot = '3' as SlotName;
    await writeSlotState(dir, slot, { phase: 'running', colour: 'a', descriptorHash: 'h1' });
    await writeSlotState(dir, slot, { phase: 'free' });
    expect(await readSlotState(dir, slot)).toEqual({ phase: 'free' });
  });

  it('propagates a read failure that is not ENOENT rather than silently reading as free', async () => {
    // A directory sitting where the state file is expected fails EISDIR --
    // a real, distinct failure mode from "no state file yet" that must not
    // be folded into the same "free" answer.
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(join(dir, 'sub.json'));
    await expect(readSlotState(dir, 'sub' as SlotName)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  // --- Item 4: a slot left `preparing` or `resetting` by a process whose
  // lock holder died is marked `error` at boot, not trusted as live. ---
  describe('recoverCrashedSlots', () => {
    it('marks a "preparing" slot "error", preserving lastHashId', async () => {
      const slot = '2' as SlotName;
      await writeSlotState(dir, slot, { phase: 'preparing', lastHashId: 'abc123' as never });

      await recoverCrashedSlots(dir, ['0', '1', '2', '3'], leaseStoreConfig, () => undefined);

      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error', lastHashId: 'abc123' });
    });

    it('marks a "resetting" slot "error" too', async () => {
      const slot = '5' as SlotName;
      await writeSlotState(dir, slot, { phase: 'resetting', lastHashId: 'zzz999' as never });

      await recoverCrashedSlots(dir, ['5'], leaseStoreConfig, () => undefined);

      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error', lastHashId: 'zzz999' });
    });

    it('leaves "free", "running" and "error" slots untouched', async () => {
      await writeSlotState(dir, '0' as SlotName, { phase: 'free' });
      await writeSlotState(dir, '1' as SlotName, {
        phase: 'running',
        colour: 'a',
        descriptorHash: 'h1',
      });
      await writeSlotState(dir, '2' as SlotName, { phase: 'error' });

      await recoverCrashedSlots(dir, ['0', '1', '2'], leaseStoreConfig, () => undefined);

      expect(await readSlotState(dir, '0' as SlotName)).toEqual({ phase: 'free' });
      expect(await readSlotState(dir, '1' as SlotName)).toEqual({
        phase: 'running',
        colour: 'a',
        descriptorHash: 'h1',
      });
      expect(await readSlotState(dir, '2' as SlotName)).toEqual({ phase: 'error' });
    });

    it('leaves a slot with no state file at all untouched (still reads "free")', async () => {
      await recoverCrashedSlots(dir, ['6'], leaseStoreConfig, () => undefined);
      expect(await readSlotState(dir, '6' as SlotName)).toEqual({ phase: 'free' });
    });

    it('logs one line per recovered slot, naming the slot and its previous phase', async () => {
      await writeSlotState(dir, '3' as SlotName, { phase: 'preparing' });
      const lines: string[] = [];

      await recoverCrashedSlots(dir, ['3'], leaseStoreConfig, (line) => lines.push(line));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"3"');
      expect(lines[0]).toContain('preparing');
    });

    // --- A slot recovered from "resetting" must also have its lease and
    // hash revoked, not just its phase marked. ---
    it('revokes the lease and hash of a slot recovered from "resetting" (a crash mid-/reset leaves the previous visitor live otherwise)', async () => {
      const slot = '4' as SlotName;
      await writeLeaseAndHash(
        { ...leaseStoreConfig, nowMs: () => 1_700_000_000_000 },
        'stale-visitor.demo-domain.example.test',
        slot,
        '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'
      );
      await writeSlotState(dir, slot, { phase: 'resetting', lastHashId: 'prev123' as never });

      await recoverCrashedSlots(dir, ['4'], leaseStoreConfig, () => undefined);

      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error', lastHashId: 'prev123' });
      const slots = JSON.parse(await readFile(leaseStoreConfig.slotsPath, 'utf8'));
      expect(slots.slots.find((e: { slot: string }) => e.slot === '4')).toBeUndefined();
      expect(await fileExists(join(leaseStoreConfig.leaseDir, '4.json'))).toBe(false);
    });

    it('leaves a "preparing" slot\'s lease untouched -- it belongs to the new tenancy, not a previous one', async () => {
      const slot = '6' as SlotName;
      await writeLeaseAndHash(
        { ...leaseStoreConfig, nowMs: () => 1_700_000_000_000 },
        'new-tenancy.demo-domain.example.test',
        slot,
        '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'
      );
      await writeSlotState(dir, slot, { phase: 'preparing' });

      await recoverCrashedSlots(dir, ['6'], leaseStoreConfig, () => undefined);

      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error' });
      const slots = JSON.parse(await readFile(leaseStoreConfig.slotsPath, 'utf8'));
      expect(slots.slots.find((e: { slot: string }) => e.slot === '6')).toBeDefined();
      expect(await fileExists(join(leaseStoreConfig.leaseDir, '6.json'))).toBe(true);
    });

    it('is a no-op revoke when a "resetting" slot has no live lease at all', async () => {
      const slot = '1' as SlotName;
      await writeSlotState(dir, slot, { phase: 'resetting' });

      await expect(
        recoverCrashedSlots(dir, ['1'], leaseStoreConfig, () => undefined)
      ).resolves.toBeUndefined();
      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error' });
    });
  });
});
