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
 * `relPath` names a file under `src/`; `mutate` must return changed text or
 * this throws. Rewrites the mutated copy's own imports so only the one
 * targeted module changes. See sourceSabotage.md#importsabotaged.
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
 * Removes `test/.sabotage-tmp/`, non-recursively, only if it is already
 * empty — never a forced recursive removal, which could delete a
 * concurrently running test file's in-flight sabotage copy. See
 * sourceSabotage.md#cleanupsabotagetmp.
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
