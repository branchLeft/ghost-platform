import { accessSync, constants } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { removeFileIfPresent, writeFileAtomic } from './atomicFile.js';
import type { Colour } from './literals.js';

/**
 * LLD-2 §01b: the drain flag is a broker-owned file, not a sudoers verb.
 * The flag directory is broker-writable and mounted read-only into the
 * sidecar's container, deliberately outside the slot's own root-owned
 * directory: that directory is wiped on every `reset`, and a flag that
 * lived there could not guarantee "boots drained" independently of reset
 * having run first. One file per (slot, colour): a colour pair shares a
 * uid and a directory but not a drain state -- exactly one colour serves
 * traffic at a time.
 */
export interface DrainFlagStore {
  set(slot: SlotName, colour: Colour): Promise<void>;
  clear(slot: SlotName, colour: Colour): Promise<void>;
  /**
   * A read of the flag the broker itself owns, for boot-time recovery
   * only (`stateStore.ts`'s `recoverSwapInFlight`) -- ordinary reconcile
   * logic never asks this, because the broker already knows what it last
   * wrote. Mirrors `services/drain-sidecar`'s own `createFileDrainFlag`
   * exactly: an unreadable directory or any error other than ENOENT reads
   * as "set" (fail closed), because a recovery step that cannot confirm a
   * colour is safe must not treat it as safe on a guess.
   */
  isSet(slot: SlotName, colour: Colour): Promise<boolean>;
}

function flagPath(dir: string, slot: SlotName, colour: Colour): string {
  return join(dir, `${slot}-${colour}.drain`);
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | undefined)?.code === 'ENOENT';
}

function directoryIsReadable(dir: string): boolean {
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function createDrainFlagStore(dir: string): DrainFlagStore {
  return {
    // Content is irrelevant -- `services/drain-sidecar`'s `createFileDrainFlag`
    // treats mere presence (an lstat that does not ENOENT) as "set".
    set: (slot, colour) => writeFileAtomic(flagPath(dir, slot, colour), '', 0o644),
    clear: (slot, colour) => removeFileIfPresent(flagPath(dir, slot, colour)),
    async isSet(slot, colour) {
      const path = flagPath(dir, slot, colour);
      try {
        await lstat(path);
        return true;
      } catch (err) {
        return !(isEnoent(err) && directoryIsReadable(dirname(path)));
      }
    },
  };
}
