import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HashId, SlotName } from '@branchleft/ghost-platform-render-core';
import { writeFileAtomic } from './atomicFile.js';
import { clearLeaseAndHash, type LeaseStoreConfig } from './leaseStore.js';
import type { Colour } from './literals.js';

/**
 * LLD-2 §04's state machine. `preparing` is the slot claimed but not yet
 * running -- written the instant `/reconcile` takes the per-slot lock
 * (`slotLock.ts`) and before any side effect, so a concurrent `/reset` or a
 * second `/reconcile` reads an occupied slot rather than a free one for the
 * whole duration of the attempt, not only after it completes.
 */
export type Phase = 'free' | 'preparing' | 'running' | 'resetting' | 'detaching' | 'error';

export interface SlotState {
  readonly phase: Phase;
  /** Set only in `running`; which of `render_slot_sudoers.py`'s two colours is live. */
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

/** A phase only ever held while `slotLock.ts`'s per-slot lock is claimed. */
const LOCK_HELD_PHASES: readonly Phase[] = ['preparing', 'resetting'];

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
  log: (line: string) => void
): Promise<void> {
  for (const literal of slotLiterals) {
    const slot = literal as SlotName;
    const state = await readSlotState(dir, slot);
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
