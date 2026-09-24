import { join } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { removeFileIfPresent, writeFileAtomic } from './atomicFile.js';
import type { Colour } from './literals.js';

/**
 * LLD-2 §01b: the drain flag is a broker-owned file, not a sudoers verb,
 * and it lives outside the slot's own root-owned, reset-wiped directory
 * (workspace#1188's review, round 3/4: the flag directory must be
 * broker-writable and mounted read-only into the sidecar's container,
 * independent of the slot directory a `reset` wipes). One file per
 * (slot, colour): a colour pair shares a uid and a directory but not a
 * drain state -- exactly one colour serves traffic at a time.
 */
export interface DrainFlagStore {
  set(slot: SlotName, colour: Colour): Promise<void>;
  clear(slot: SlotName, colour: Colour): Promise<void>;
}

function flagPath(dir: string, slot: SlotName, colour: Colour): string {
  return join(dir, `${slot}-${colour}.drain`);
}

export function createDrainFlagStore(dir: string): DrainFlagStore {
  return {
    // Content is irrelevant -- `services/drain-sidecar`'s `createFileDrainFlag`
    // treats mere presence (an lstat that does not ENOENT) as "set".
    set: (slot, colour) => writeFileAtomic(flagPath(dir, slot, colour), '', 0o644),
    clear: (slot, colour) => removeFileIfPresent(flagPath(dir, slot, colour)),
  };
}
