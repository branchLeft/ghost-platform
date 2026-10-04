import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HashId, SlotName } from '@branchleft/ghost-platform-render-core';
import { writeFileAtomic } from './atomicFile.js';
import type { DrainFlagStore } from './drainFlag.js';
import { waitUntilReady, type GhostReadinessChecker } from './ghostReadiness.js';
import { clearLeaseAndHash, type LeaseStoreConfig } from './leaseStore.js';
import { otherColour, type Colour } from './literals.js';
import { slotPort } from './slotPorts.js';
import type { SlotWrapper } from './wrapper.js';

/**
 * The slot state machine. `preparing` is claimed-but-not-yet-running,
 * `swapping` is `attemptColourSwap`'s own in-flight marker, and `stopping`
 * is `attemptStopOldColour`'s. Each exists so a crash partway through its
 * function's side effects is recoverable rather than invisible to a stale
 * `running` phase. See stateStore.md#phase.
 */
export type Phase =
  'free' | 'preparing' | 'running' | 'swapping' | 'stopping' | 'resetting' | 'detaching' | 'error';

export interface SlotState {
  readonly phase: Phase;
  /**
   * Set in `running`, and in `swapping` names the colour that was live
   * *before* the swap started (the swap's own source) -- which of
   * `render_slot_sudoers.py`'s two colours is live, or was, going in.
   */
  readonly colour?: Colour;
  /** A stable hash of the last descriptor reconciled, for idempotent replay. */
  readonly descriptorHash?: string;
  /**
   * `hashIdOf()` of the most recently active tenancy's hash, carried
   * forward across `reset` (never cleared to `undefined` by it) so the next
   * `/reconcile` can refuse an unrotated hash -- the recycle contract's
   * broker-discipline half (`render-core/src/lease.ts`): "the slot's
   * argon2id hash must be replaced on every recycle."
   */
  readonly lastHashId?: HashId;
  /**
   * Set only in `swapping`: the colour `attemptColourSwap` is deploying
   * *into*. Recorded before any side effect precisely so a boot-time
   * recovery can tell "a swap into this colour was in flight" apart from
   * "this slot is quietly running" -- the same distinction `preparing`
   * already draws for a fresh deploy, and one `running` alone cannot draw
   * for a swap, because `running` is also what a swap's *own* successful
   * final write leaves behind.
   */
  readonly swapTarget?: Colour;
  /**
   * Set only in `swapping`: the new descriptor's own hash/hashId, computed
   * once at the top of `attemptColourSwap` and carried here so a recovery
   * that finds the target colour already safely live can adopt it with
   * the *correct* `descriptorHash`/`lastHashId` -- not `undefined`, which
   * would still be safe (idempotent replay simply never fires) but would
   * needlessly force every next `/reconcile` through a fresh swap attempt
   * even for a descriptor the recovered colour is already running.
   */
  readonly swapDescriptorHash?: string;
  readonly swapHashId?: HashId;
  /**
   * Set only on a `running` state reached by a completed swap: the
   * real-traffic counter's reading for this slot, taken the instant the
   * swap's traffic-moving step finished. `attemptStopOldColour` refuses
   * until a fresh reading exceeds this one. See stateStore.md#trafficbaseline.
   */
  readonly trafficBaseline?: number;
  /**
   * Set once `attemptStopOldColour` has actually stopped
   * `otherColour(colour)`. Absent (or `false`) means the old colour is
   * still running, drained, per U7 -- the bake-window default a completed
   * swap always leaves behind. Makes a second `/stop` call idempotent
   * without re-running either pre-stop check.
   */
  readonly oldColourStopped?: boolean;
  /**
   * The evidence copy's custody, set only by freeze-and-detach. `frozen`
   * means the copy has been taken but not yet confirmed as sealed, hashed
   * and moved to the held area; `detached` means that confirmation landed.
   * Absent means no evidence was ever taken. `/reset` refuses while this
   * is `frozen`, whatever the phase, and recovery paths carry it forward
   * rather than dropping it. See stateStore.md#resetrefusal.
   */
  readonly evidence?: 'frozen' | 'detached';
}

/**
 * Why a slot may not be reset, or `undefined` when it may. The evidence
 * leaves by `detaching` before the slot resets, so a slot still detaching,
 * or whose freeze is not yet confirmed detached (including one a crashed
 * detach left in `error`), keeps its state until a confirmed detach
 * releases it. Every path that wipes a slot asks this first. See
 * stateStore.md#resetrefusal.
 */
export function resetRefusal(state: SlotState, slot: SlotName): string | undefined {
  if (state.phase === 'detaching') {
    return `slot "${slot}" is detaching its held evidence -- refusing to reset it until the detach is confirmed`;
  }
  if (state.evidence === 'frozen') {
    return `slot "${slot}" holds frozen evidence not yet confirmed detached (phase "${state.phase}") -- refusing to reset it`;
  }
  return undefined;
}

/**
 * The `error` state recovery writes, carrying forward the evidence marker
 * so a fail-closed recovery can never release a slot's held evidence.
 */
export function errorStateOf(state: SlotState): SlotState {
  return state.evidence === undefined
    ? { phase: 'error', lastHashId: state.lastHashId }
    : { phase: 'error', lastHashId: state.lastHashId, evidence: state.evidence };
}

export class UnrotatedHashError extends Error {
  constructor(readonly slot: SlotName) {
    super(`slot "${slot}"'s new hash is identical to its previous tenancy's hash`);
    this.name = 'UnrotatedHashError';
  }
}

/**
 * The one check downstream of the broker that nothing else can make:
 * `render-core/src/lease.ts` says rotation is broker discipline, not a
 * checkable invariant, and refusing the recycle is strictly safer than
 * writing a hash the previous visitor already knows. Compares only against
 * `lastHashId`, the immediately previous tenancy, so a hash reused two
 * recycles back (A -> B -> A) is accepted. See stateStore.md#asserthashrotated.
 */
export function assertHashRotated(state: SlotState, newHashId: HashId, slot: SlotName): void {
  if (state.lastHashId !== undefined && state.lastHashId === newHashId) {
    throw new UnrotatedHashError(slot);
  }
}

const FREE_STATE: SlotState = { phase: 'free' };

function statePath(dir: string, slot: SlotName): string {
  return join(dir, `${slot}.json`);
}

export async function readSlotState(dir: string, slot: SlotName): Promise<SlotState> {
  let text: string;
  try {
    text = await readFile(statePath(dir, slot), 'utf8');
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return FREE_STATE;
    throw err;
  }
  return JSON.parse(text) as SlotState;
}

export async function writeSlotState(dir: string, slot: SlotName, state: SlotState): Promise<void> {
  await writeFileAtomic(statePath(dir, slot), JSON.stringify(state));
}

/** A phase only ever held while `slotLock.ts`'s per-slot lock is claimed, and recovered by
 * unconditionally marking it `error` -- `swapping` is also lock-held, but is recovered by
 * `recoverSwapInFlight` instead, which needs to look at more than the phase alone. */
const LOCK_HELD_PHASES: readonly Phase[] = ['preparing', 'resetting'];

/**
 * Recovers a slot found `swapping` at boot. Never trusts the stale
 * persisted state to say which colour is live -- re-derives liveness from
 * real signals (drain flag clear and Ghost answering) for both source and
 * target, and the two swap directions are not symmetric in what that
 * implies. See stateStore.md#recoverswapinflight.
 */
export async function recoverSwapInFlight(
  dir: string,
  slot: SlotName,
  state: SlotState,
  drainFlags: Pick<DrainFlagStore, 'isSet' | 'set'>,
  ghostReadiness: GhostReadinessChecker,
  appPortBase: number,
  readyPollTimeoutMs: number,
  log: (line: string) => void
): Promise<void> {
  const source = state.colour;
  const target = state.swapTarget;
  if (source === undefined || target === undefined) {
    // Should be unreachable -- `attemptColourSwap` never writes `swapping`
    // without both -- but a state file is host-writable data, not a type
    // the runtime can trust; fails exactly like the "neither live" outcome
    // rather than reading `undefined` into a port computation.
    log(
      `slot "${slot}" was left "swapping" with no recorded source/target colour -- marking "error"`
    );
    await writeSlotState(dir, slot, errorStateOf(state));
    return;
  }

  // Hoisted function declarations below do not see the guard's narrowing.
  const targetColour: Colour = target;

  function portOf(colour: Colour): number {
    return slotPort(appPortBase, slot, colour);
  }
  async function isLive(colour: Colour): Promise<boolean> {
    if (await drainFlags.isSet(slot, colour)) return false;
    return waitUntilReady(ghostReadiness, portOf(colour), readyPollTimeoutMs);
  }
  async function adoptTarget(): Promise<void> {
    log(
      `slot "${slot}" recovered a swap that reached colour "${target}" before the process died -- adopting it`
    );
    await writeSlotState(dir, slot, {
      phase: 'running',
      colour: target,
      descriptorHash: state.swapDescriptorHash,
      lastHashId: state.swapHashId ?? state.lastHashId,
    });
  }
  async function revertToSource(): Promise<void> {
    log(
      `slot "${slot}" recovered a swap that never safely reached colour "${target}" -- colour "${source}" is still what's actually live`
    );
    // The target may have been cleared and merely slow to answer. Left
    // clear, it would take the traffic as soon as it came up if it is the
    // first-listed colour, while this state records the source. Safe:
    // the source was just confirmed live.
    await drainFlags.set(slot, targetColour);
    await writeSlotState(dir, slot, {
      phase: 'running',
      colour: source,
      descriptorHash: state.descriptorHash,
      lastHashId: state.lastHashId,
    });
  }
  async function failClosed(): Promise<void> {
    log(
      `slot "${slot}" recovered from a swap with NEITHER colour "${source}" nor "${target}" confirmed live -- marking "error" rather than guessing`
    );
    await writeSlotState(dir, slot, errorStateOf(state));
  }

  const targetLive = await isLive(target);
  if (targetLive) {
    if (target === 'a') {
      // This direction never drains the source at all -- a live source
      // alongside a live target is the intended end state, not a
      // question this outcome needs to ask.
      await adoptTarget();
      return;
    }
    // target === 'b': clearing its flag alone moved nothing. Whether the
    // swap's own traffic-moving step (draining the source) already ran
    // is the question that actually decides this outcome.
    const sourceStillLive = await isLive(source);
    if (!sourceStillLive) {
      // The source is already drained -- the crash landed after the
      // swap's traffic-moving step, not before it.
      await adoptTarget();
      return;
    }
    // Both live: the dangerous window itself. One more direct check
    // immediately before the one side effect this branch performs,
    // mirroring `attemptColourSwap`'s own drain-refusal guard.
    if (await ghostReadiness.isReady(portOf(target))) {
      log(
        `slot "${slot}" recovered a swap that reached colour "${target}" but crashed before draining colour "${source}" -- completing the drain now`
      );
      await drainFlags.set(slot, source);
      await adoptTarget();
      return;
    }
    // The target regressed in the narrow window between the two checks --
    // fall through exactly as if it had never been confirmed live at all.
  }

  const sourceLive = await isLive(source);
  if (sourceLive) {
    await revertToSource();
    return;
  }

  await failClosed();
}

/**
 * Recovers a slot found `stopping` at boot: a crash between
 * `attemptStopOldColour` calling `wrapper.stop` and its own final
 * `writeSlotState`. Which colour to act on is never ambiguous, but still
 * re-checks the survivor is live before retrying the stop -- retrying it
 * unconditionally could remove the only colour with any chance of being
 * live. See stateStore.md#recoverstoppingslot.
 */
export async function recoverStoppingSlot(
  dir: string,
  slot: SlotName,
  state: SlotState,
  wrapper: Pick<SlotWrapper, 'stop'>,
  drainFlags: Pick<DrainFlagStore, 'isSet'>,
  ghostReadiness: Pick<GhostReadinessChecker, 'isReady'>,
  appPortBase: number,
  log: (line: string) => void
): Promise<void> {
  if (state.colour === undefined) {
    // Unreachable in practice (see the doc comment above), guarded the
    // same way `recoverSwapInFlight` guards its own two required fields:
    // a state file is host-writable data, not a type the runtime can
    // trust.
    log(`slot "${slot}" was left "stopping" with no recorded colour -- marking "error"`);
    await writeSlotState(dir, slot, errorStateOf(state));
    return;
  }
  const survivor = state.colour;
  const target = otherColour(survivor);

  const survivorPort = slotPort(appPortBase, slot, survivor);
  const survivorLive =
    !(await drainFlags.isSet(slot, survivor)) && (await ghostReadiness.isReady(survivorPort));
  if (!survivorLive) {
    log(
      `slot "${slot}" was left "stopping" colour "${target}" by a process that died before recording it, but survivor colour "${survivor}" is not confirmed live now -- marking "error" rather than stopping colour "${target}" and leaving the slot with no colour serving`
    );
    await writeSlotState(dir, slot, errorStateOf(state));
    return;
  }

  log(
    `slot "${slot}" was left "stopping" colour "${target}" by a process that died before recording it -- retrying the stop (idempotent) and completing the transition`
  );
  await wrapper.stop(slot, target);
  await writeSlotState(dir, slot, {
    phase: 'running',
    colour: survivor,
    descriptorHash: state.descriptorHash,
    lastHashId: state.lastHashId,
    trafficBaseline: state.trafficBaseline,
    oldColourStopped: true,
  });
}

/**
 * Boot-time recovery for a slot whose lock holder died mid-transition
 * (`preparing` or `resetting`, since the per-slot lock lives only in
 * process memory). Fail-closed to `error` rather than guessing the slot
 * back to `free` or `running`. A slot found `resetting` also has its
 * previous tenancy's lease and hash revoked here first, since
 * `handleReset` writes the phase before revoking.
 * See stateStore.md#recovercrashedslots.
 */
export async function recoverCrashedSlots(
  dir: string,
  slotLiterals: readonly string[],
  leaseStoreConfig: Pick<LeaseStoreConfig, 'slotsPath' | 'leaseDir'>,
  log: (line: string) => void,
  swapRecovery: {
    readonly drainFlags: Pick<DrainFlagStore, 'isSet' | 'set'>;
    readonly ghostReadiness: GhostReadinessChecker;
    readonly appPortBase: number;
    readonly readyPollTimeoutMs: number;
  },
  /**
   * Optional so every existing caller that never exercises `stopping`
   * keeps compiling unchanged. Its absence is itself fail-safe: a
   * `stopping` slot found with no wrapper to retry the stop against is
   * marked `error` below, exactly like a `preparing`/`resetting` slot with
   * no live lock holder -- never guessed back to `running`.
   */
  stopRecovery?: {
    readonly wrapper: Pick<SlotWrapper, 'stop'>;
  }
): Promise<void> {
  for (const literal of slotLiterals) {
    const slot = literal as SlotName;
    const state = await readSlotState(dir, slot);
    if (state.phase === 'swapping') {
      await recoverSwapInFlight(
        dir,
        slot,
        state,
        swapRecovery.drainFlags,
        swapRecovery.ghostReadiness,
        swapRecovery.appPortBase,
        swapRecovery.readyPollTimeoutMs,
        log
      );
      continue;
    }
    if (state.phase === 'stopping') {
      if (stopRecovery) {
        await recoverStoppingSlot(
          dir,
          slot,
          state,
          stopRecovery.wrapper,
          swapRecovery.drainFlags,
          swapRecovery.ghostReadiness,
          swapRecovery.appPortBase,
          log
        );
      } else {
        log(
          `slot "${slot}" was left "stopping" with no stop-recovery wrapper configured -- marking "error" rather than guessing the old colour was ever actually stopped`
        );
        await writeSlotState(dir, slot, errorStateOf(state));
      }
      continue;
    }
    if (LOCK_HELD_PHASES.includes(state.phase)) {
      log(
        `slot "${slot}" was left "${state.phase}" by a process that never reached free, running or error -- marking it "error" for an explicit /reset`
      );
      if (state.phase === 'resetting') {
        log(`slot "${slot}" was mid-reset: revoking its lease and hash before marking it "error"`);
        await clearLeaseAndHash(leaseStoreConfig, slot);
      }
      await writeSlotState(dir, slot, errorStateOf(state));
    }
  }
}
