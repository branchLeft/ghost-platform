/**
 * Real source-mutation sabotage. Copies the whole of `src/` to a throwaway
 * directory, changes one string in one file, and imports the mutated copy,
 * never the checked-in file and never a re-implementation written in a test.
 * A mutation that does not apply throws, so a sabotage can never be a no-op.
 *
 * Re-derived locally from render-core's idiom: that helper rewrites one
 * module's imports back to the real tree, which cannot mutate a module the
 * others import (the ring order), and a service may not import across the
 * package boundary.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // test/unit/helpers
const srcDir = join(here, '..', '..', '..', 'src');
const tmpRoot = join(here, '..', '..', '.sabotage-tmp'); // test/.sabotage-tmp, git-ignored

export interface Mutation {
  /** A file under `src/`, such as `ringController.ts`. */
  file: string;
  /** The exact text to replace. It must occur in the file. */
  find: string;
  replace: string;
}

/** Imports `entry` (a file under `src/`) from a copy of `src/` with every mutation applied. */
export async function importSabotaged<T>(
  entry: string,
  mutations: readonly Mutation[]
): Promise<T> {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = join(tmpRoot, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cpSync(srcDir, dir, { recursive: true, filter: (source) => !source.endsWith('.md') });
  try {
    for (const { file, find, replace } of mutations) {
      const path = join(dir, file);
      const original = readFileSync(path, 'utf-8');
      if (!original.includes(find)) {
        throw new Error(
          `importSabotaged: '${find}' is not in ${file}; the sabotage would be a no-op.`
        );
      }
      const mutated = original.replace(find, () => replace);
      if (mutated === original) {
        throw new Error(`importSabotaged: replacing in ${file} changed nothing.`);
      }
      writeFileSync(path, mutated);
    }
    return (await import(/* @vite-ignore */ join(dir, entry))) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Removes `test/.sabotage-tmp/` only if it is already empty; never a forced removal of a sibling's live copy. */
export function cleanupSabotageTmp(): void {
  try {
    rmdirSync(tmpRoot);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      throw error;
    }
  }
}
