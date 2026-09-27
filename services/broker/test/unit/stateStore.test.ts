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
  drainFlags: { isSet: async () => true, set: async () => undefined },
  ghostReadiness: { isReady: async () => false },
  appPortBase: 9300,
  readyPollTimeoutMs: 50,
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
      drainFlags: {
        isSet: (slot: SlotName, colour: 'a' | 'b') => Promise<boolean>;
        set: (slot: SlotName, colour: 'a' | 'b') => Promise<void>;
      };
      ghostReadiness: { isReady: (port: number) => Promise<boolean> };
      appPortBase: number;
      readyPollTimeoutMs: number;
      readonly drainSetCalls: ('a' | 'b')[];
    } {
      const drained = new Set(opts.drainedColours ?? []);
      const healthy = new Set(opts.healthyColours ?? []);
      const appPortBase = 9300;
      // slotPorts.ts: appPortBase + slot*2 (+1 for 'b') -- slot '0' here.
      const portOf = (colour: 'a' | 'b') => appPortBase + (colour === 'b' ? 1 : 0);
      const drainSetCalls: ('a' | 'b')[] = [];
      return {
        drainFlags: {
          isSet: async (_slot, colour) => drained.has(colour),
          set: async (_slot, colour) => {
            drained.add(colour);
            drainSetCalls.push(colour);
          },
        },
        ghostReadiness: { isReady: async (port) => healthy.has(portOf('a') === port ? 'a' : 'b') },
        appPortBase,
        readyPollTimeoutMs: 50,
        drainSetCalls,
      };
    }

    it("target 'a' (first-listed): a live, undrained source alongside a live target is this direction's own intended end state -- adopts the target without ever touching the source", async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'swapping',
        colour: 'b',
        swapTarget: 'a',
        swapDescriptorHash: 'new-hash',
        swapHashId: 'new-hash-id' as never,
        lastHashId: 'old-hash-id' as never,
      });
      // Both genuinely live and undrained: 'a' (target) cleared its flag,
      // which alone moves everything in this direction (LLD-4 §U3b) -- 'b'
      // (source) is never drained by this direction's own design, so it is
      // left exactly as it was, still healthy.
      const swapRecovery = fakeSwapRecovery({ drainedColours: [], healthyColours: ['a', 'b'] });

      await recoverCrashedSlots(dir, [slot], leaseStoreConfig, () => undefined, swapRecovery);

      expect(await readSlotState(dir, slot)).toEqual({
        phase: 'running',
        colour: 'a',
        descriptorHash: 'new-hash',
        lastHashId: 'new-hash-id',
      });
      expect(swapRecovery.drainSetCalls).toEqual([]);
    });

    it("target 'b' (second-listed), source already drained: the swap's own traffic-moving step already ran before the crash -- adopts the target, never the stale source", async () => {
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
      expect(swapRecovery.drainSetCalls).toEqual([]); // already drained; nothing further to do
    });

    // --- The dangerous window itself (review cycle 2's own blocking
    // finding): target 'b' cleared and ready, source still live and
    // undrained -- the exact crash point between attemptColourSwap
    // clearing the target's flag and draining the source. "The target is
    // live" is not the same question as "the swap moved traffic" for this
    // direction (LLD-4 §U3b): clearing 'b's flag alone moves nothing while
    // 'a' is still healthy and preferred. Recovery must never adopt the
    // target while leaving the source live too -- it must complete the
    // interrupted drain first. ---
    it("target 'b', source still live and undrained (the dangerous window): completes the interrupted drain of the source, then adopts the target -- never adopts with both live", async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'swapping',
        colour: 'a',
        swapTarget: 'b',
        swapDescriptorHash: 'new-hash',
        swapHashId: 'new-hash-id' as never,
        lastHashId: 'old-hash-id' as never,
      });
      // Both genuinely live and undrained: exactly the crash window a
      // process dying right after `clear(slot, 'b')` and right before
      // `drainFlags.set(slot, 'a')` leaves behind.
      const swapRecovery = fakeSwapRecovery({ drainedColours: [], healthyColours: ['a', 'b'] });

      await recoverCrashedSlots(dir, [slot], leaseStoreConfig, () => undefined, swapRecovery);

      // Exactly one colour serving at the end: the source was drained as
      // part of recovery, and the target was adopted -- never both live,
      // never the target adopted without the source having been drained.
      expect(swapRecovery.drainSetCalls).toEqual(['a']);
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

    // --- Ghost's own post-boot maintenance window (ghostReadiness.ts's own
    // doc comment) can make a genuinely-live colour answer not-ready on the
    // one unlucky instant a single-shot probe checks it -- recovery polls
    // with `waitUntilReady`, the swap's own bring-up semantics, precisely
    // so a transient first miss is never mistaken for a real fault. ---
    it('a transient first-probe miss on the target, followed by ready, still adopts it -- never a false "error"', async () => {
      const slot = '0' as SlotName;
      // target 'a': adopting it needs only the target's own liveness (this
      // direction never drains the source), which isolates the assertion
      // to exactly the polling behaviour under test -- no other branch's
      // logic can change the outcome here.
      await writeSlotState(dir, slot, {
        phase: 'swapping',
        colour: 'b',
        swapTarget: 'a',
        swapDescriptorHash: 'new-hash',
        swapHashId: 'new-hash-id' as never,
        lastHashId: 'old-hash-id' as never,
      });
      const callsByPort = new Map<number, number>();
      const swapRecovery = {
        drainFlags: { isSet: async () => false, set: async () => undefined },
        // Not ready on the very first probe of any given port (the
        // maintenance-window shape), ready on every one after -- a
        // single-shot check would read this as "not live" and mark the
        // slot "error"; the polled check must not.
        ghostReadiness: {
          isReady: async (port: number) => {
            const seen = (callsByPort.get(port) ?? 0) + 1;
            callsByPort.set(port, seen);
            return seen > 1;
          },
        },
        appPortBase: 9300,
        readyPollTimeoutMs: 2000,
      };

      await recoverCrashedSlots(dir, [slot], leaseStoreConfig, () => undefined, swapRecovery);

      // 9300 is target 'a''s own app port (slotPorts.ts, slot "0") -- it
      // really did poll more than once rather than trusting one probe.
      expect(callsByPort.get(9300)).toBeGreaterThan(1);
      expect(await readSlotState(dir, slot)).toEqual({
        phase: 'running',
        colour: 'a',
        descriptorHash: 'new-hash',
        lastHashId: 'new-hash-id',
      });
    });
  });

  // --- A crash between `attemptStopOldColour` calling
  // `wrapper.stop` and its own final `writeSlotState`. Unlike "swapping",
  // there is no health signal to poll -- `state.colour` already names the
  // survivor by construction, so the other colour is unambiguous, and
  // repeating an idempotent `stop` is always safe. ---
  describe('recoverCrashedSlots on a "stopping" slot (crash mid-stop)', () => {
    function fakeStopRecovery(): {
      wrapper: { stop: (slot: SlotName, colour: 'a' | 'b') => Promise<void> };
      readonly stopCalls: { slot: SlotName; colour: 'a' | 'b' }[];
    } {
      const stopCalls: { slot: SlotName; colour: 'a' | 'b' }[] = [];
      return {
        wrapper: {
          stop: async (slot, colour) => {
            stopCalls.push({ slot, colour });
          },
        },
        stopCalls,
      };
    }

    it('retries the stop against the other colour (never the survivor) and completes the transition', async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'stopping',
        colour: 'b',
        descriptorHash: 'hash-b',
        lastHashId: 'hash-id-b' as never,
        trafficBaseline: 3,
      });
      const stopRecovery = fakeStopRecovery();

      await recoverCrashedSlots(
        dir,
        [slot],
        leaseStoreConfig,
        () => undefined,
        NEVER_SWAP_RECOVERY,
        stopRecovery
      );

      // 'b' is the survivor -- only 'a' is ever named to the wrapper.
      expect(stopRecovery.stopCalls).toEqual([{ slot, colour: 'a' }]);
      expect(await readSlotState(dir, slot)).toEqual({
        phase: 'running',
        colour: 'b',
        descriptorHash: 'hash-b',
        lastHashId: 'hash-id-b',
        trafficBaseline: 3,
        oldColourStopped: true,
      });
    });

    it('is safe to run twice -- systemctl stop on an already-stopped unit is a no-op, and recovery never guesses that away', async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'stopping',
        colour: 'a',
        descriptorHash: 'hash-a',
        lastHashId: 'hash-id-a' as never,
        trafficBaseline: 1,
      });
      const stopRecovery = fakeStopRecovery();
      await recoverCrashedSlots(
        dir,
        [slot],
        leaseStoreConfig,
        () => undefined,
        NEVER_SWAP_RECOVERY,
        stopRecovery
      );
      expect(stopRecovery.stopCalls).toEqual([{ slot, colour: 'b' }]);
    });

    it('marks "error" rather than guessing, if left "stopping" with no colour recorded at all', async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'stopping',
        lastHashId: 'x' as never,
      } as never);
      const stopRecovery = fakeStopRecovery();

      await recoverCrashedSlots(
        dir,
        [slot],
        leaseStoreConfig,
        () => undefined,
        NEVER_SWAP_RECOVERY,
        stopRecovery
      );

      expect(stopRecovery.stopCalls).toEqual([]);
      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error', lastHashId: 'x' });
    });

    it('marks "error" rather than guessing, if no stop-recovery wrapper is configured at all -- never silently trusts the stale "running" state was reached safely', async () => {
      const slot = '0' as SlotName;
      await writeSlotState(dir, slot, {
        phase: 'stopping',
        colour: 'a',
        lastHashId: 'x' as never,
        trafficBaseline: 1,
      });

      // No sixth argument at all -- the exact shape every caller from
      // before this story still uses.
      await recoverCrashedSlots(
        dir,
        [slot],
        leaseStoreConfig,
        () => undefined,
        NEVER_SWAP_RECOVERY
      );

      expect(await readSlotState(dir, slot)).toEqual({ phase: 'error', lastHashId: 'x' });
    });
  });
});
