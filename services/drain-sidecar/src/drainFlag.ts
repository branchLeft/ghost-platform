import { existsSync } from 'node:fs';

export interface DrainFlag {
  isSet(): boolean;
}

/**
 * The flag is a file's mere presence, not its contents, and it is owned by
 * the broker rather than by this process. A stat-and-forget check matches
 * that contract exactly: no lock, no read, no cached state to fall out of
 * sync with the file a different process is writing.
 */
export function createFileDrainFlag(path: string): DrainFlag {
  return {
    isSet: () => existsSync(path),
  };
}
