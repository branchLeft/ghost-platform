import { accessSync, constants, statSync } from 'node:fs';
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
 * The flag is a file's mere presence, not its contents, and it is owned by
 * the broker rather than by this process. A stat-and-forget check matches
 * that contract exactly: no lock, no read, no cached state to fall out of
 * sync with the file a different process is writing.
 *
 * "The flag is absent" and "this process cannot tell" are different
 * answers, and only the first is safe to read as clear. A stat that fails
 * with anything other than ENOENT against a directory this process can
 * itself read and traverse -- a permission error, a missing directory, a
 * path component that isn't one -- is treated as set: a slot that cannot
 * confirm it is safe must not serve traffic on the strength of a guess.
 */
export function createFileDrainFlag(path: string): DrainFlag {
  const dir = dirname(path);

  return {
    isSet: () => {
      try {
        statSync(path);
        return true;
      } catch (err) {
        return !(isEnoent(err) && directoryIsReadable(dir));
      }
    },
  };
}
