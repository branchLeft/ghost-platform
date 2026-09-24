import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { writeFileAtomic } from './atomicFile.js';
import type { Colour } from './literals.js';

/**
 * LLD-2 §04's state machine, minus "preparing" -- this service's
 * `/reconcile` runs synchronously to completion (or to its retry-then-error
 * outcome) rather than returning early and moving the slot through
 * "preparing" as a separately observable phase, so there is no interval in
 * which this store would ever hold that value. A future async reconcile
 * could add it without changing this type's other members.
 */
export type Phase = 'free' | 'running' | 'resetting' | 'detaching' | 'error';

export interface SlotState {
  readonly phase: Phase;
  /** Set only in `running`; which of `render_slot_sudoers.py`'s two colours is live. */
  readonly colour?: Colour;
  /** A stable hash of the last descriptor reconciled, for idempotent replay. */
  readonly descriptorHash?: string;
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
