import { existsSync, statSync, utimesSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import { baseBrokerEnv } from '../helpers/brokerEnv.js';
import {
  writeValidAdminApiPlugin,
  writeValidDrainSourcePlugin,
  writeValidImageLoaderPlugin,
  writeValidRendererPlugin,
} from '../helpers/pluginFixtures.js';
import {
  ensureBuilt,
  findFreePort,
  MAX_BIND_ATTEMPTS,
  spawnBroker,
  type SpawnedBroker,
} from '../helpers/spawnBroker.js';

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

/**
 * A port another process already holds makes the broker exit with
 * EADDRINUSE before it listens. `waitListening` must then pick a new port
 * and respawn, and give up with a clear error after MAX_BIND_ATTEMPTS.
 */
describe('spawnBroker retries a port taken before the broker can listen', () => {
  let occupier: Server | undefined;
  let broker: SpawnedBroker | undefined;

  afterEach(() => {
    broker?.stop();
    broker = undefined;
    occupier?.close();
    occupier = undefined;
  });

  /** A valid environment for the broker: the same four plugin seams server.test wires. */
  async function envWithPlugins(): Promise<Record<string, string>> {
    const { env } = await baseBrokerEnv();
    const root = await makeTempDir('broker-retry-');
    return {
      ...env,
      BROKER_RENDERER_MODULE: await writeValidRendererPlugin(root),
      BROKER_ADMIN_API_MODULE: await writeValidAdminApiPlugin(root),
      BROKER_DRAIN_SOURCE_MODULE: await writeValidDrainSourcePlugin(root),
      BROKER_IMAGE_LOADER_MODULE: await writeValidImageLoaderPlugin(root),
    };
  }

  async function occupyPort(): Promise<number> {
    occupier = createServer();
    await new Promise<void>((resolve) => occupier?.listen(0, '127.0.0.1', resolve));
    return (occupier.address() as { port: number }).port;
  }

  it('binds a second port when the first is occupied', async () => {
    const taken = await occupyPort();
    const env = await envWithPlugins();
    let picks = 0;
    broker = spawnBroker(
      { ...env, PORT: String(taken) },
      {
        pickPort: async () => {
          picks += 1;
          return findFreePort();
        },
      }
    );
    const { port } = await broker.waitListening(8000);
    expect(port).not.toBe(taken);
    expect(picks).toBe(1);
    expect(broker.output()).toMatch(/broker listening on [^:]+:\d+/);
  });

  it('fails clearly after MAX_BIND_ATTEMPTS when every port is taken', async () => {
    const taken = await occupyPort();
    const env = await envWithPlugins();
    broker = spawnBroker({ ...env, PORT: String(taken) }, { pickPort: async () => taken });
    await expect(broker.waitListening(8000)).rejects.toThrow(
      `could not bind a free port in ${MAX_BIND_ATTEMPTS} attempts`
    );
  });
});
