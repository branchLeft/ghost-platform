import { mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Owns the flag for the transient export colour this package creates and
 * tears down itself -- one export, one colour, never reused. Mirrors
 * services/broker/src/drainFlag.ts's own file-per-(slot, colour) shape and
 * its reasoning: content is irrelevant, only presence matters (see
 * ./drainFlag.ts), and the write is atomic so a reader never observes a
 * half-written flag file.
 */
export interface DrainFlagStore {
  set(colourId: string): Promise<void>;
  clear(colourId: string): Promise<void>;
}

/**
 * Exported so a caller wiring this store's write side to drainFlag.ts's
 * read side (see cli.ts) computes the identical path both directions --
 * the two must never drift, or the read-back in exportRunner.ts's own
 * boot-drained check would silently check nothing real.
 */
export function flagPathFor(dir: string, colourId: string): string {
  return join(dir, `${colourId}.drain`);
}

async function writeAtomic(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, '', { mode: 0o600 });
  await rename(tmp, path);
}

export function createDrainFlagStore(dir: string): DrainFlagStore {
  return {
    set: (colourId) => writeAtomic(flagPathFor(dir, colourId)),
    clear: (colourId) => rm(flagPathFor(dir, colourId), { force: true }),
  };
}
