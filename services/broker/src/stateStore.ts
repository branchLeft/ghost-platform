import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HashId, SlotName } from '@branchleft/ghost-platform-render-core';
import { writeFileAtomic } from './atomicFile.js';
import type { DrainFlagStore } from './drainFlag.js';
import type { GhostReadinessChecker } from './ghostReadiness.js';
import { clearLeaseAndHash, type LeaseStoreConfig } from './leaseStore.js';
import type { Colour } from './literals.js';
import { slotPort } from './slotPorts.js';

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
 */
export type Phase =
  'free' | 'preparing' | 'running' | 'swapping' | 'resetting' | 'detaching' | 'error';

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
 * before any caller has reached the edge at all).
 *
 * Three outcomes, in order of preference:
 * 1. **The target is confirmed live** (flag clear, Ghost answering): the
 *    swap reached the point where the target became this slot's own live
 *    colour -- whether or not the crash *also* happened before the source
 *    was drained (the swap's own `'a'`-direction never drains the source
 *    at all, by design, so a live source alongside a live target is the
 *    *intended* end state for that direction, not a fault). Adopts the
 *    target, with the swap's own carried-forward `swapDescriptorHash`/
 *    `swapHashId` so idempotent replay works correctly for the descriptor
 *    that crash interrupted, not merely safely.
 * 2. **Only the source is confirmed live**: the swap never got the target
 *    safely up. Reverts to the source, exactly as `attemptColourSwap`'s
 *    own synchronous failure path already does when it catches an error
 *    instead of crashing -- this is that same recovery, taken by the next
 *    boot instead of the same process.
 * 3. **Neither is confirmed live**: fails closed, the same `error` phase
 *    `preparing`/`resetting` recovery already uses for "nothing here knows
 *    enough to guess" -- guessing which colour to trust with no evidence
 *    either way is exactly the failure mode this function exists to avoid.
 */
export async function recoverSwapInFlight(
  dir: string,
  slot: SlotName,
  state: SlotState,
  drainFlags: Pick<DrainFlagStore, 'isSet'>,
  ghostReadiness: GhostReadinessChecker,
  appPortBase: number,
  log: (line: string) => void
): Promise<void> {
  const source = state.colour;
  const target = state.swapTarget;
  if (source === undefined || target === undefined) {
    // Should be unreachable -- `attemptColourSwap` never writes `swapping`
    // without both -- but a state file is host-writable data, not a type
    // the runtime can trust; fails exactly like case 3 rather than reading
    // `undefined` into a port computation.
    log(
      `slot "${slot}" was left "swapping" with no recorded source/target colour -- marking "error"`
    );
    await writeSlotState(dir, slot, { phase: 'error', lastHashId: state.lastHashId });
    return;
  }

  async function isLive(colour: Colour): Promise<boolean> {
    if (await drainFlags.isSet(slot, colour)) return false;
    return ghostReadiness.isReady(slotPort(appPortBase, slot, colour));
  }

  const targetLive = await isLive(target);
  if (targetLive) {
    log(
      `slot "${slot}" recovered a swap that reached colour "${target}" before the process died -- adopting it`
    );
    await writeSlotState(dir, slot, {
      phase: 'running',
      colour: target,
      descriptorHash: state.swapDescriptorHash,
      lastHashId: state.swapHashId ?? state.lastHashId,
    });
    return;
  }

  const sourceLive = await isLive(source);
  if (sourceLive) {
    log(
      `slot "${slot}" recovered a swap that never safely reached colour "${target}" -- colour "${source}" is still what's actually live`
    );
    await writeSlotState(dir, slot, {
      phase: 'running',
      colour: source,
      descriptorHash: state.descriptorHash,
      lastHashId: state.lastHashId,
    });
    return;
  }

  log(
    `slot "${slot}" recovered from a swap with NEITHER colour "${source}" nor "${target}" confirmed live -- marking "error" rather than guessing`
  );
  await writeSlotState(dir, slot, { phase: 'error', lastHashId: state.lastHashId });
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
    readonly drainFlags: Pick<DrainFlagStore, 'isSet'>;
    readonly ghostReadiness: GhostReadinessChecker;
    readonly appPortBase: number;
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
        log
      );
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
