/**
 * Regression: a sibling test file's `cleanupSabotageTmp()` must not remove the
 * directory another file's `importSabotaged()` is writing into.
 *
 * `importSabotaged` runs `mkdirSync` and then `writeFileSync` as two steps.
 * Vitest runs test files in parallel workers, and `cleanupSabotageTmp` does a
 * non-recursive `rmdirSync` of the directory whenever it is empty. The
 * interleaving that failed in CI (ENOENT on `test/.sabotage-tmp/...`) is a
 * cleanup landing between those two steps. Two threads cannot be scheduled
 * between two adjacent synchronous calls in one test, so this file replays that
 * one step deterministically: its `writeFileSync` first removes the shared
 * directory the way a sibling's cleanup would, then writes for real.
 */
import { describe, expect, it, vi } from 'vitest';
import { importSabotaged } from './helpers/sourceSabotage.js';

const legacySharedDir = await vi.hoisted(async () => {
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  return join(dirname(fileURLToPath(import.meta.url)), '.sabotage-tmp');
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      // A sibling file's cleanupSabotageTmp(), landing between mkdir and write.
      try {
        actual.rmdirSync(legacySharedDir);
      } catch {
        // ENOENT or ENOTEMPTY: cleanupSabotageTmp ignores both, so do the same.
      }
      return actual.writeFileSync(...args);
    },
  };
});

describe('importSabotaged under a concurrent sibling cleanup', () => {
  it('still imports the mutated copy when the shared directory is removed mid-call', async () => {
    const mod = await importSabotaged<{ validateSlugAvailability?: unknown }>(
      'naming.ts',
      (source) => `${source}\n// sabotage race probe\n`
    );
    expect(typeof mod.validateSlugAvailability).toBe('function');
  });
});
