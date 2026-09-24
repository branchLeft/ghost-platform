import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HashId, SlotName } from '@branchleft/ghost-platform-render-core';
import { writeFileAtomic } from './atomicFile.js';
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
