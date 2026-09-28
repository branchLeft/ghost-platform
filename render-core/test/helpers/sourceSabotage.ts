/**
 * Real source-mutation sabotage: reads a module's actual committed source
 * from `src/`, applies a text mutation, writes the mutated text to a
 * throwaway file and imports *that* — never the checked-in file, and never
 * a re-implementation written inline in a test. An in-suite "sabotage" that
 * only mutates a string inside the test, never the source, is not evidence
 * the source itself would be caught if it regressed.
 */
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // render-core/test/helpers
const srcDir = join(here, '..', '..', 'src'); // render-core/src
const tmpDir = join(here, '..', '.sabotage-tmp'); // render-core/test/.sabotage-tmp -- one level under test/, matching the "../../src/" rewrite below

/**
 * `relPath` names a file under `src/` (e.g. `'environment.ts'`). `mutate`
 * receives its exact text and must return a changed version — an
 * unchanged return throws, so a sabotage that silently stopped mutating
 * anything (a typo'd search string, for example) fails loudly instead of
 * quietly testing the unmodified real module.
 *
 * The mutated copy is written one directory deeper than `src/`
 * (`test/.sabotage-tmp/`), so every one of its own `from './x.js'`
 * imports is rewritten to `from '../../src/x.js'` first — everything the
 * mutated module itself imports still resolves to the real, unmutated
 * source, which is the point: exactly one function changes.
 */
export async function importSabotaged<T>(
  relPath: string,
  mutate: (source: string) => string
): Promise<T> {
  const srcPath = join(srcDir, relPath);
  const original = readFileSync(srcPath, 'utf-8');
  const mutated = mutate(original);
  if (mutated === original) {
    throw new Error(
      `importSabotaged: mutate() did not change ${relPath} -- sabotage would be a no-op.`
    );
  }
  const rewritten = mutated.replace(/from '\.\//g, "from '../../src/");
  mkdirSync(tmpDir, { recursive: true });
  const outPath = join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${relPath}`);
  writeFileSync(outPath, rewritten);
  try {
    return (await import(/* @vite-ignore */ outPath)) as T;
  } finally {
    rmSync(outPath, { force: true });
  }
}

/**
 * Removes `test/.sabotage-tmp/` -- but only if it is already empty. Every
 * `importSabotaged` call above removes its own throwaway file in its own
 * `finally`, so by the time one test file's tests finish, this shared
 * directory is normally empty already; a non-recursive `rmdirSync` only
 * ever succeeds in that case. Vitest runs test files concurrently by
 * default, and every file that sabotages a source module shares this one
 * directory (it is not namespaced per file) -- a recursive, forced removal
 * here would delete a sibling file's still-in-flight sabotage copy out
 * from under it the moment two files' sabotage calls overlapped, which is
 * exactly the failure this non-recursive form cannot cause: it either
 * finds the directory empty and removes it, or finds it non-empty (another
 * file mid-write) and leaves it alone.
 */
export function cleanupSabotageTmp(): void {
  try {
    rmdirSync(tmpDir);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      throw error;
    }
  }
}
