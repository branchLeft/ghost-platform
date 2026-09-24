import { existsSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensureBuilt } from '../helpers/spawnBroker.js';

const SERVICE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST_SERVER = join(SERVICE_ROOT, 'dist', 'server.js');
// Any file under `src/` proves the mechanism; `slotPorts.ts` is small and
// not on the hot path of any concurrently-running spawned-server test, so
// bumping its mtime here cannot be mistaken for a real edit anyone else
// depends on.
const A_SOURCE_FILE = join(SERVICE_ROOT, 'src', 'slotPorts.ts');

/**
 * `ensureBuilt()` used to check only that `dist/server.js` existed, so a
 * `dist/` built once from clean source stayed "built" for the rest of a
 * local session even after `src/` changed under it -- a wiring sabotage's
 * own regression test could then run against stale JS and report green.
 * This proves the fixed version actually rebuilds when `dist/server.js` is
 * older than the newest file under `src/`, using the exact `dist/server.js`
 * every spawned-server test in this suite runs against (the real
 * entrypoint), not a throwaway copy.
 */
describe('ensureBuilt (a stale dist/ must not pass as built)', () => {
  it('rebuilds when dist/server.js is older than the newest file under src/', () => {
    // A build already exists by the time any test file runs (every other
    // spawned-server test calls `ensureBuilt()` too); this only actually
    // invokes `tsc` if this is somehow the very first one to run.
    ensureBuilt();
    expect(existsSync(DIST_SERVER)).toBe(true);

    const originalSrcMtime = statSync(A_SOURCE_FILE).mtime;
    const distMtimeMsBefore = statSync(DIST_SERVER).mtimeMs;
    try {
      // Stamp the source file a full minute past *real* wall-clock time
      // (not past dist's own mtime, which a real rebuild's own mtime --
      // itself just "now" when `tsc` writes the file -- would otherwise
      // never need to catch up to): the exact relationship a real edit
      // made after the last build leaves between the two files' mtimes.
      const future = new Date(Date.now() + 60_000);
      utimesSync(A_SOURCE_FILE, future, future);
      expect(statSync(A_SOURCE_FILE).mtimeMs).toBeGreaterThan(distMtimeMsBefore);

      ensureBuilt();

      // A rebuild ran: dist/server.js's own mtime moved forward from what
      // it was before -- proof `tsc` actually wrote the file again, not
      // that it now carries the source's own (arbitrary) future stamp.
      const distMtimeMsAfter = statSync(DIST_SERVER).mtimeMs;
      expect(distMtimeMsAfter).toBeGreaterThan(distMtimeMsBefore);
    } finally {
      // Restore the source file's real mtime and rebuild once more so
      // dist/server.js reflects the actual, current source again for
      // every other test file that spawns it.
      utimesSync(A_SOURCE_FILE, originalSrcMtime, originalSrcMtime);
      ensureBuilt();
    }
  });
});
