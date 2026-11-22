/**
 * Real source-mutation sabotage: copies a module's committed source from
 * `src/`, applies a text mutation, and imports the mutated copy, never the
 * checked-in file and never a re-implementation written inline in a test.
 * Every other module the copy imports is the real one, except another file
 * named in `mutations`, which is imported as its own mutated copy.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');
const tmpRoot = join(here, '..', '.sabotage-tmp');

export type Mutation = (source: string) => string;

/**
 * Imports `entry` (a file under `src/`) with `mutations` applied. `entry`
 * is copied even when it is not named, so it can import the mutated copies.
 * A mutation that changes nothing throws: it would prove nothing.
 */
export async function importSabotaged<T>(
  entry: string,
  mutations: Readonly<Record<string, Mutation>>
): Promise<T> {
  const names = new Set([entry, ...Object.keys(mutations)]);
  const dir = join(tmpRoot, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    for (const name of names) {
      const original = readFileSync(join(srcDir, name), 'utf-8');
      const mutate = mutations[name];
      const mutated = mutate === undefined ? original : mutate(original);
      if (mutate !== undefined && mutated === original) {
        throw new Error(`importSabotaged: the mutation of ${name} changed nothing`);
      }
      const rewritten = mutated.replace(/from '\.\/([^']+)\.js'/g, (_whole, stem: string) =>
        names.has(`${stem}.ts`) ? `from './${stem}.js'` : `from '../../../src/${stem}.js'`
      );
      writeFileSync(join(dir, name), rewritten);
    }
    return (await import(/* @vite-ignore */ join(dir, entry))) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Removes the scratch root once it is empty; never a recursive delete of someone else's copy. */
export function cleanupSabotageTmp(): void {
  try {
    rmSync(tmpRoot, { recursive: false });
  } catch {
    // Not empty, or already gone.
  }
}
