/**
 * Real source-mutation sabotage: reads a module's committed source from
 * `src/`, applies a text mutation, writes the mutated text to a throwaway file
 * and imports that, never the checked-in file and never a re-implementation
 * written inline in a test. A mutation that changes nothing throws, so a
 * sabotage can never quietly become a no-op after the source moves.
 */
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // services/broker/test/helpers
const srcDir = join(here, '..', '..', 'src');
// One level under test/, matching the "../../src/" the imports are rewritten to.
const tmpDir = join(here, '..', '.sabotage-tmp');

export async function importSabotaged<T>(
  relPath: string,
  mutate: (source: string) => string
): Promise<T> {
  const original = readFileSync(join(srcDir, relPath), 'utf-8');
  const mutated = mutate(original);
  if (mutated === original) {
    throw new Error(`importSabotaged: the mutation did not change ${relPath}: it would be a no-op`);
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

/** Removes `test/.sabotage-tmp/` only if it is already empty: never a recursive removal. */
export function cleanupSabotageTmp(): void {
  try {
    rmdirSync(tmpDir);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
}
