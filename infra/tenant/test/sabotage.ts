/**
 * Source-mutation sabotage for infra/tenant, a trimmed port of render-core's
 * `test/helpers/sourceSabotage.ts`. It reads a module's committed source,
 * applies a text mutation, writes the result to a throwaway file and imports
 * that copy. Only for modules with no relative imports (naming.ts has none).
 */
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const here = __dirname; // infra/tenant/test (this package builds to CommonJS)
const tmpDir = join(here, '.sabotage-tmp');

export async function importSabotaged<T>(
  relPath: string,
  mutate: (source: string) => string
): Promise<T> {
  const original = readFileSync(join(here, '..', relPath), 'utf-8');
  const mutated = mutate(original);
  if (mutated === original) {
    throw new Error(`importSabotaged: mutate() did not change ${relPath}; a no-op proves nothing.`);
  }
  mkdirSync(tmpDir, { recursive: true });
  const outPath = join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}-${relPath}`);
  writeFileSync(outPath, mutated);
  try {
    return (await import(/* @vite-ignore */ outPath)) as T;
  } finally {
    rmSync(outPath, { force: true });
  }
}

/** Removes the scratch directory only if it is already empty. */
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
