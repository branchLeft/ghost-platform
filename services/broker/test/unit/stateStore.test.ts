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

// Every `recoverCrashedSlots` test in this file except the dedicated
// `recoverSwapInFlight`/`"swapping"` ones below is about `preparing`/
// `resetting`, neither of which ever reaches this argument -- a fixture
// that answers "drained"/"not ready" for everything, so a test that
// somehow did reach it would see the failed-closed branch, never a silent
// "recovered fine".
const NEVER_SWAP_RECOVERY = {
  drainFlags: { isSet: async () => true },
  ghostReadiness: { isReady: async () => false },
  appPortBase: 9300,
};

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

      await recoverCrashedSlots(
        dir,
        ['0', '1', '2', '3'],
        leaseStoreConfig,
        () => undefined,
        NEVER_SWAP_RECOVERY
      );

      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error', lastHashId: 'abc123' });
    });

    it('marks a "resetting" slot "error" too', async () => {
      const slot = '5' as SlotName;
      await writeSlotState(dir, slot, { phase: 'resetting', lastHashId: 'zzz999' as never });

      await recoverCrashedSlots(dir, ['5'], leaseStoreConfig, () => undefined, NEVER_SWAP_RECOVERY);

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

      await recoverCrashedSlots(
        dir,
        ['0', '1', '2'],
        leaseStoreConfig,
        () => undefined,
        NEVER_SWAP_RECOVERY
      );

      expect(await readSlotState(dir, '0' as SlotName)).toEqual({ phase: 'free' });
      expect(await readSlotState(dir, '1' as SlotName)).toEqual({
        phase: 'running',
        colour: 'a',
        descriptorHash: 'h1',
      });
      expect(await readSlotState(dir, '2' as SlotName)).toEqual({ phase: 'error' });
    });

    it('leaves a slot with no state file at all untouched (still reads "free")', async () => {
      await recoverCrashedSlots(dir, ['6'], leaseStoreConfig, () => undefined, NEVER_SWAP_RECOVERY);
      expect(await readSlotState(dir, '6' as SlotName)).toEqual({ phase: 'free' });
    });

    it('logs one line per recovered slot, naming the slot and its previous phase', async () => {
      await writeSlotState(dir, '3' as SlotName, { phase: 'preparing' });
      const lines: string[] = [];

      await recoverCrashedSlots(
        dir,
        ['3'],
        leaseStoreConfig,
        (line) => lines.push(line),
        NEVER_SWAP_RECOVERY
      );

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

      await recoverCrashedSlots(dir, ['4'], leaseStoreConfig, () => undefined, NEVER_SWAP_RECOVERY);

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

      await recoverCrashedSlots(dir, ['6'], leaseStoreConfig, () => undefined, NEVER_SWAP_RECOVERY);

      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error' });
      const slots = JSON.parse(await readFile(leaseStoreConfig.slotsPath, 'utf8'));
      expect(slots.slots.find((e: { slot: string }) => e.slot === '6')).toBeDefined();
      expect(await fileExists(join(leaseStoreConfig.leaseDir, '6.json'))).toBe(true);
    });

    it('is a no-op revoke when a "resetting" slot has no live lease at all', async () => {
      const slot = '1' as SlotName;
      await writeSlotState(dir, slot, { phase: 'resetting' });

      await expect(
        recoverCrashedSlots(dir, ['1'], leaseStoreConfig, () => undefined, NEVER_SWAP_RECOVERY)
      ).resolves.toBeUndefined();
      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error' });
    });
  });

  // --- A crash mid-swap must never be invisible
  // to boot-time recovery. `attemptColourSwap` (app.ts) writes `swapping`
  // with `colour` (the source) and `swapTarget` before any side effect;
  // these tests drive `recoverCrashedSlots` against every reality a crash
  // partway through the swap's own side effects could leave behind,
  // built from real drain-flag files (never a stale-state guess) plus a
  // controllable health signal standing in for a real Ghost. ---
  describe('recoverCrashedSlots on a "swapping" slot (crash mid-swap)', () => {
    function fakeSwapRecovery(opts: {
      readonly drainedColours?: readonly ('a' | 'b')[];
      readonly healthyColours?: readonly ('a' | 'b')[];
    }): {
      drainFlags: { isSet: (slot: SlotName, colour: 'a' | 'b') => Promise<boolean> };
      ghostReadiness: { isReady: (port: number) => Promise<boolean> };
      appPortBase: number;
    } {
      const drained = new Set(opts.drainedColours ?? []);
      const healthy = new Set(opts.healthyColours ?? []);
      const appPortBase = 9300;
      // slotPorts.ts: appPortBase + slot*2 (+1 for 'b') -- slot '0' here.
      const portOf = (colour: 'a' | 'b') => appPortBase + (colour === 'b' ? 1 : 0);
      return {
        drainFlags: { isSet: async (_slot, colour) => drained.has(colour) },
        ghostReadiness: { isReady: async (port) => healthy.has(portOf('a') === port ? 'a' : 'b') },
        appPortBase,
      };
    }

    it("crash after the target became live (flag clear + healthy): adopts the target, with the swap's own hash", async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'swapping',
        colour: 'a',
        swapTarget: 'b',
        swapDescriptorHash: 'new-hash',
        swapHashId: 'new-hash-id' as never,
        lastHashId: 'old-hash-id' as never,
      });
      // Reality at the crash instant: 'b' cleared and healthy -- 'a' was
      // never touched by this direction's own swap, so it is untouched by
      // this fixture too (still whatever it was, irrelevant to the verdict).
      const swapRecovery = fakeSwapRecovery({ drainedColours: [], healthyColours: ['b'] });

      await recoverCrashedSlots(dir, [slot], leaseStoreConfig, () => undefined, swapRecovery);

      expect(await readSlotState(dir, slot)).toEqual({
        phase: 'running',
        colour: 'b',
        descriptorHash: 'new-hash',
        lastHashId: 'new-hash-id',
      });
    });

    it("crash after clearing target AND draining the source (the review's own exact scenario): adopts the target, never the stale source", async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'swapping',
        colour: 'a',
        swapTarget: 'b',
        swapDescriptorHash: 'new-hash',
        swapHashId: 'new-hash-id' as never,
        lastHashId: 'old-hash-id' as never,
      });
      // 'a' (source) drained, 'b' (target) clear and healthy -- the
      // dangerous state a retried /reconcile would otherwise misread as
      // "'a' is still live", and drain 'b' too.
      const swapRecovery = fakeSwapRecovery({ drainedColours: ['a'], healthyColours: ['b'] });

      await recoverCrashedSlots(dir, [slot], leaseStoreConfig, () => undefined, swapRecovery);

      expect(await readSlotState(dir, slot)).toEqual({
        phase: 'running',
        colour: 'b',
        descriptorHash: 'new-hash',
        lastHashId: 'new-hash-id',
      });
    });

    it('crash before the target ever became safely live: reverts to the source, exactly as a synchronous failure already would', async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'swapping',
        colour: 'a',
        swapTarget: 'b',
        swapDescriptorHash: 'new-hash',
        swapHashId: 'new-hash-id' as never,
        lastHashId: 'old-hash-id' as never,
      });
      // Target 'b' still drained (never got past the render/start/verify
      // steps) -- 'a' is untouched and still genuinely serving.
      const swapRecovery = fakeSwapRecovery({ drainedColours: ['b'], healthyColours: ['a'] });

      await recoverCrashedSlots(dir, [slot], leaseStoreConfig, () => undefined, swapRecovery);

      expect(await readSlotState(dir, slot)).toEqual({
        phase: 'running',
        colour: 'a',
        lastHashId: 'old-hash-id',
      });
    });

    it('crash with NEITHER colour confirmed live: fails closed to "error" rather than guessing', async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'swapping',
        colour: 'a',
        swapTarget: 'b',
        swapDescriptorHash: 'new-hash',
        swapHashId: 'new-hash-id' as never,
        lastHashId: 'old-hash-id' as never,
      });
      // Both drained (or unhealthy) -- an outage the recovery must name,
      // never paper over by picking one to trust with no evidence.
      const swapRecovery = fakeSwapRecovery({ drainedColours: ['a', 'b'], healthyColours: [] });

      await recoverCrashedSlots(dir, [slot], leaseStoreConfig, () => undefined, swapRecovery);

      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error', lastHashId: 'old-hash-id' });
    });

    it('a "swapping" slot with no recorded swapTarget (should be unreachable) still fails closed', async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, { phase: 'swapping', colour: 'a', lastHashId: 'x' as never });
      const swapRecovery = fakeSwapRecovery({ healthyColours: ['a', 'b'] });

      await recoverCrashedSlots(dir, [slot], leaseStoreConfig, () => undefined, swapRecovery);

      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error', lastHashId: 'x' });
    });
  });
});
