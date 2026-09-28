import { accessSync, constants, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DrainFlag {
  isSet(): boolean;
}

// Spelled out instead of NodeJS.ErrnoException so this file has no
// dependency on the ambient @types/node globals eslint's plain
// (non-type-aware) config doesn't resolve.
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
 * A stat-and-forget presence check, fails closed on anything but ENOENT.
 * See ../README.md#how-the-flag-is-checked.
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
