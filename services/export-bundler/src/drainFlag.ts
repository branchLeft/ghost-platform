import { accessSync, constants, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DrainFlag {
  isSet(): boolean;
}

// Spelled out instead of NodeJS.ErrnoException so this file has no
// dependency on the ambient @types/node globals eslint's plain
// (non-type-aware) config doesn't resolve -- mirrors
// services/drain-sidecar/src/drainFlag.ts's own reasoning.
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

/**
 * Duplicated from services/drain-sidecar/src/drainFlag.ts rather than
 * imported: neither package is published, so cross-package reuse here
 * would mean a private path import outside this package's own tree.
 * services/broker/src/healthCheck.ts already sets the precedent for this
 * repo -- mirror the contract, keep the copy small.
 *
 * The contract is identical: mere presence (an lstat that does not ENOENT)
 * is "set", a dangling symlink still reads as set, and anything other than
 * a clean ENOENT against a directory this process can itself read is
 * treated as set -- a bundler that cannot confirm a colour is safe must
 * not run an administrator-level bulk export against it on a guess.
 */
export function createFileDrainFlag(path: string): DrainFlag {
  const dir = dirname(path);

  return {
    isSet: () => {
      try {
        lstatSync(path);
        return true;
      } catch (err) {
        return !(isEnoent(err) && directoryIsReadable(dir));
      }
    },
  };
}
