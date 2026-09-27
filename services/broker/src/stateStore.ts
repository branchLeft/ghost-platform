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
 * LLD-2 §04's state machine. `preparing` is the slot claimed but not yet
 * running -- written the instant `/reconcile` takes the per-slot lock
 * (`slotLock.ts`) and before any side effect, so a concurrent `/reset` or a
 * second `/reconcile` reads an occupied slot rather than a free one for the
 * whole duration of the attempt, not only after it completes.
 *
 * `swapping` is `attemptColourSwap`'s own equivalent (`app.ts`): a colour
 * swap has its own multi-step side effects, and a crash partway through
 * one is exactly as invisible to a stale `running` phase as a crashed
 * fresh deploy would be to a missing `preparing` -- see
 * `recoverSwapInFlight`, below, for what a crash there needs, which is
 * more than just "mark it error" (unlike `preparing`/`resetting`,
 * something is genuinely still serving throughout a swap, and guessing
 * wrong about which colour that is would fail the wrong one closed).
 *
 * `stopping` is `attemptStopOldColour`'s own equivalent (`app.ts`): recorded
 * before calling the wrapper's `stop` on the colour a completed swap left
 * running-but-drained (LLD-4 §U7), so a crash between that call and this
 * phase's own final write is recoverable rather than silently leaving the
 * slot's persisted state saying "running, colour X" while an operator has
 * no way to tell whether the other colour was actually stopped. Unlike
 * `swapping`, nothing here is ambiguous about *which* colour to act on --
 * `state.colour` already names the one survivor, so the other one is
 * `otherColour(state.colour)` by construction, not something recovery has
 * to re-derive from health signals the way `recoverSwapInFlight` must for
 * `swapping`.
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
   * Set only on a `running` state reached by a completed swap (never by a
   * fresh deploy into a `free` slot, which has no "old colour" to stop):
   * `services/demo-gate`'s real-traffic counter's own reading for this
   * slot, taken the instant the swap's traffic-moving step finished.
   * `attemptStopOldColour` refuses until a fresh reading exceeds this one
   * -- the falsification clause's "served real traffic", not "reported
   * healthy" (LLD-4 §04). Colour-blind like the counter itself: valid
   * precisely because only `colour` (the survivor) can receive traffic
   * from the moment this was taken (see `realTraffic.ts`'s doc comment).
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
}

export class UnrotatedHashError extends Error {
  constructor(readonly slot: SlotName) {
    super(`slot "${slot}"'s new hash is identical to its previous tenancy's hash`);
    this.name = 'UnrotatedHashError';
  }
}

/**
 * The one check downstream of the broker that nothing else can make:
 * `render-core/src/lease.ts`'s comment says rotation "is broker discipline,
 * not a checkable invariant" -- checkable, in fact, exactly here, against
 * what the previous tenancy left behind, and refusing the recycle is
 * strictly safer than writing a hash the previous visitor already knows.
 *
 * **Design decision (workspace#1323, reviewed against the contract's own
 * wording): this compares only against `lastHashId`, the immediately
 * previous tenancy, so a hash reused two recycles back (A -> B -> A) is
 * accepted.** `render-core/src/lease.ts`'s clause (a) reads "the slot's
 * `argon2id` hash must be replaced on every recycle" -- literally a
 * one-step comparison, not "never reused across the slot's history", and
 * B -> A still replaces B's hash. A -> B -> A is therefore within the
 * contract as written: the previous visitor (B) cannot log in again, which
 * is the property clause (a) protects; only a visitor from two tenancies
 * ago could, and only by guessing that history and the current passphrase.
 * A bounded history would close that narrower residual risk, but nothing
 * in the contract or LLD-2 requires it, so this stays a one-step check
 * until the contract itself changes.
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
 * Recovers a slot found `swapping` at boot -- a crash partway through
 * `attemptColourSwap`'s side effects (`app.ts`). Unlike `preparing`/
 * `resetting`, marking it blindly `error` is not safe here: something is
 * genuinely still serving traffic throughout a swap (that is the whole
 * point of the mechanism), and `error` would fail a colour closed that a
 * caller might otherwise still be able to reach correctly if this function
 * simply told the truth about which one it is.
 *
 * **Never trusts the stale persisted state to say which colour is live.**
 * `state.colour` is the swap's own *source* -- correct only for as long as
 * the swap it was reading never got far enough to move traffic, and this
 * function's whole reason to exist is that it might have. Re-derives
 * liveness from the two real signals a running colour has to have (LLD-4
 * §U3b's own sidecar contract): its drain flag clear, *and* Ghost itself
 * answering at its own app port -- the same two conditions `services/
 * drain-sidecar` combines into one `/healthz` verdict, checked here
 * directly rather than through the sidecar (this runs at broker boot,
 * before any caller has reached the edge at all). Each check polls with
 * `waitUntilReady`, the swap's own bring-up semantics, rather than a
 * single probe: Ghost's post-boot maintenance window (a couple of
 * seconds, `ghostReadiness.ts`) would otherwise read a genuinely-healthy
 * colour as not-ready on the one unlucky instant this runs at, and a
 * false `error` here sends an operator toward `/reset`, which stops
 * *both* colours.
 *
 * **Direction matters, and the two directions are not symmetric (LLD-4
 * §U3b).** Deploying into `'a'` (first-listed): clearing its flag is
 * already the one flag change that moves everything, and the source
 * (`'b'`) is never drained at all by that direction's own design -- a live
 * source alongside a live target is the *intended* end state, not a
 * fault. Deploying into `'b'` (second-listed): clearing its flag moves
 * *nothing* on its own (`'a'` is still preferred); only draining `'a'`
 * afterwards actually moves traffic. So for `target === 'b'`, "the target
 * is live" is not the same question as "the swap moved traffic" -- both
 * colours can be live and undrained at once, in the exact window between
 * `attemptColourSwap` clearing `'b'`'s flag and draining `'a'`, and a
 * crash there must never be read as success while `'a'` is still what
 * every real reader is actually being served from.
 *
 * Per-direction outcomes:
 * - **`target === 'a'`**: target live -> adopt it (source's own state is
 *   irrelevant, by the direction's own design, above). Otherwise source
 *   live -> revert to it. Otherwise -> `error`.
 * - **`target === 'b'`**: target live *and* source already drained -> the
 *   swap's own traffic-moving step already ran before the crash; adopt
 *   the target. Target live *and* source still live -> the dangerous
 *   window itself: re-verifies the target directly (mirroring
 *   `attemptColourSwap`'s own second, independent check immediately
 *   before its one traffic-moving step) and, if it still holds, completes
 *   the interrupted drain of the source right here before adopting the
 *   target -- never adopts with both colours left live. If that
 *   re-verification fails, falls through to the source-liveness check
 *   below exactly as if the target had never been confirmed at all.
 *   Otherwise (target not live) -> source live -> revert to it.
 *   Otherwise -> `error`.
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
    await writeSlotState(dir, slot, { phase: 'error', lastHashId: state.lastHashId });
    return;
  }

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
    await writeSlotState(dir, slot, { phase: 'error', lastHashId: state.lastHashId });
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
 * Recovers a slot found `stopping` at boot -- a crash between
 * `attemptStopOldColour` calling `wrapper.stop` and its own final
 * `writeSlotState`. Unlike `recoverSwapInFlight`, which colour to act on is
 * never ambiguous: `state.colour` already names the survivor by
 * construction (a `stopping` write is only ever reached from a `running`
 * state with `colour` set), so the other colour is unambiguous, and
 * stopping it is idempotent -- `systemctl stop` on an already-stopped unit
 * is a no-op (LLD-2 §02).
 *
 * **Still re-checks the survivor is live before retrying, exactly like
 * `attemptStopOldColour`'s own third check, immediately before its call to
 * `wrapper.stop` (`app.ts`).** A crash can land here for reasons that have
 * nothing to do with the stop itself -- the survivor can have gone
 * unhealthy in the gap between the original attempt and this reboot -- and
 * retrying `wrapper.stop` on the other colour in that world is exactly the
 * fault "no step may ever leave a tenant with no colour serving" exists to
 * refuse mid-swap: it would remove the *only* colour with any chance of
 * being live. Idempotence of the stop call says nothing about whether it is
 * still *safe* to make; only re-deriving liveness, not the stale persisted
 * phase, answers that. If the survivor is not confirmed live, this marks
 * the slot `error` instead of stopping anything -- the same fail-closed
 * outcome `recoverSwapInFlight` reaches when neither colour is confirmed
 * live, and precisely the gap the review round on this story found: a
 * boot-time retry that stopped the other colour unconditionally, with no
 * liveness re-check at all.
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
    await writeSlotState(dir, slot, { phase: 'error', lastHashId: state.lastHashId });
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
    await writeSlotState(dir, slot, { phase: 'error', lastHashId: state.lastHashId });
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
 * Boot-time recovery for a slot whose lock holder died mid-transition. The
 * per-slot lock lives in process memory (`slotLock.ts`), so it never
 * survives a restart -- a persisted `preparing` or `resetting` phase found
 * here can only be left over from a process that crashed before reaching
 * `free`, `running` or `error`.
 *
 * Fail-closed, chosen deliberately over guessing the slot back to `free` or
 * `running`: nothing at boot knows how far the crashed attempt got, so
 * silently resuming it could hand a caller a slot whose rendered artefacts,
 * wrapper state and lease disagree with each other. Marking it `error`
 * instead reuses the phase this broker already answers with "something
 * went wrong; call `/reset`" (`handleReconcile`'s own retry-then-error
 * path), so every caller already knows how to recover it, and `GET
 * /status` -- LLD-2 §03's deliberately unauthenticated, always-answering
 * endpoint -- reports it distinctly from a live `preparing` rather than
 * looking identical to one still genuinely in flight.
 *
 * The phase alone is not enough for a slot recovered from `resetting`:
 * `handleReset` writes `resetting` *before* it revokes the previous
 * tenancy's lease and hash, so a crash in that narrow window leaves them
 * live while the phase already says "being torn down". Marking it `error`
 * without also revoking would fail the phase closed while leaving access
 * open -- the previous visitor keeps logging in for however long it takes
 * an operator to notice and call `/reset`. Revoking here first, the same
 * order `handleReset` itself uses, closes that gap immediately rather than
 * waiting on a caller. A slot recovered from `preparing`, by contrast, has
 * no previous tenancy's access to revoke: whatever lease exists there (if
 * any got as far as being written) belongs to the new tenancy that never
 * finished starting, not to one still logging in.
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
        await writeSlotState(dir, slot, { phase: 'error', lastHashId: state.lastHashId });
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
      await writeSlotState(dir, slot, { phase: 'error', lastHashId: state.lastHashId });
    }
  }
}
