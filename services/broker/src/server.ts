import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBrokerHandler, type BrokerDeps } from './app.js';
import type { AdminApiClient } from './adminApi.js';
import { createInMemoryNonceStore } from './nonceStore.js';
import { loadConfig, type BrokerConfig, type BrokerEnv } from './config.js';
import { createDrainFlagStore } from './drainFlag.js';
import type { DrainSource } from './drainSource.js';
import { createHttpHealthChecker } from './healthCheck.js';
import type { Renderer } from './render.js';
import { createSlotLock } from './slotLock.js';
import { recoverCrashedSlots } from './stateStore.js';
import { createSlotWrapper } from './wrapper.js';

function isRenderer(candidate: unknown): candidate is Renderer {
  return typeof (candidate as Partial<Renderer> | undefined)?.render === 'function';
}
function isAdminApiClient(candidate: unknown): candidate is AdminApiClient {
  return typeof (candidate as Partial<AdminApiClient> | undefined)?.configure === 'function';
}
function isDrainSource(candidate: unknown): candidate is DrainSource {
  return typeof (candidate as Partial<DrainSource> | undefined)?.poll === 'function';
}

/**
 * `Renderer`, `AdminApiClient` and `DrainSource` are seams this story
 * deliberately leaves unimplemented (see each file's own doc comment):
 * the descriptor-to-artefacts renderer is workspace#1183's unbuilt "seven
 * artefacts, pure" package; the Admin API call's content is unspecified by
 * any design document; the drain source depends on LLD-6's unbuilt mail
 * spool and an unbuilt "reaper". Rather than ship a fake implementation of
 * any of them -- which would silently pass its own tests while doing
 * nothing real in production -- this entrypoint loads each from a module
 * path named by its own environment variable and refuses to start if one
 * is missing *or if its default export does not have the seam's required
 * function*: a module that loads cleanly but exports nothing usable must
 * fail exactly as loudly as one that was never pointed to at all, rather
 * than reaching the handler as `undefined` and failing obscurely on the
 * first request instead.
 */
export async function loadPlugin<T>(
  envVar: string,
  env: BrokerEnv,
  isValid: (candidate: unknown) => candidate is T
): Promise<T> {
  const modulePath = env[envVar];
  if (!modulePath) {
    throw new Error(
      `${envVar} is not set. This service has no default ${envVar.replace('BROKER_', '').replace('_MODULE', '')} -- see the doc comment on the seam's own interface file for why, and point ${envVar} at a module whose default export implements it.`
    );
  }
  const mod = (await import(modulePath)) as { default?: unknown };
  if (!isValid(mod.default)) {
    throw new Error(
      `${envVar} at "${modulePath}" has no default export implementing the required interface.`
    );
  }
  return mod.default;
}

/**
 * The whole of how a loaded config and the three plugin seams become the
 * deps `createBrokerHandler` runs against -- extracted so a test can build
 * the exact same wiring `main()` uses (see server.test.ts) rather than
 * reconstructing an approximation of it (`test/helpers/testBroker.ts`
 * builds its own `BrokerDeps` directly, which proves the handler's logic
 * but not this wiring -- both are needed).
 */
export function buildDeps(
  config: BrokerConfig,
  renderer: Renderer,
  adminApi: AdminApiClient,
  drainSource: DrainSource
): BrokerDeps {
  return {
    auth: {
      verifyKey: config.verifyKey,
      replayWindowSeconds: config.replayWindowSeconds,
      nonces: createInMemoryNonceStore(config.replayWindowSeconds * 1000),
      processStartSeconds: config.processStartSeconds,
      nowMs: config.nowMs,
    },
    slotLiterals: config.slotLiterals,
    zones: config.zones,
    wrapper: createSlotWrapper({
      command: config.wrapperCommand,
      prefix: config.wrapperPrefix,
      timeoutMs: config.wrapperTimeoutMs,
    }),
    renderer,
    adminApi,
    drainSource,
    leaseStoreConfig: {
      slotsPath: config.slotsPath,
      leaseDir: config.leaseDir,
      nowMs: config.nowMs,
    },
    drainFlags: createDrainFlagStore(config.drainFlagDir),
    healthChecker: createHttpHealthChecker('127.0.0.1', config.healthCheckTimeoutMs),
    healthPortBase: config.healthPortBase,
    appPortBase: config.appPortBase,
    uidBase: config.uidBase,
    slotDirBase: config.slotDirBase,
    stateDir: config.stateDir,
    slotLock: createSlotLock(),
    drainPollTimeoutMs: config.drainPollTimeoutMs,
    nowMs: config.nowMs,
    log: (line) => console.error(line),
  };
}

export async function main(): Promise<Server> {
  const config = loadConfig(process.env);
  await mkdir(config.stateDir, { recursive: true });
  await mkdir(config.drainFlagDir, { recursive: true });
  await mkdir(config.leaseDir, { recursive: true });

  // Before anything below can accept a request: a slot a previous process
  // left `preparing` or `resetting` had its lock holder die with it (the
  // lock is in-memory and this is a fresh process), so it cannot be trusted
  // as still in flight. See `recoverCrashedSlots`'s own doc comment for why
  // `error` (fail-closed) rather than a guess at `free` or `running`, and
  // why a `resetting` slot also has its lease and hash revoked here.
  await recoverCrashedSlots(
    config.stateDir,
    config.slotLiterals,
    { slotsPath: config.slotsPath, leaseDir: config.leaseDir },
    (line) => console.error(line)
  );

  const renderer = await loadPlugin('BROKER_RENDERER_MODULE', process.env, isRenderer);
  const adminApi = await loadPlugin('BROKER_ADMIN_API_MODULE', process.env, isAdminApiClient);
  const drainSource = await loadPlugin('BROKER_DRAIN_SOURCE_MODULE', process.env, isDrainSource);

  const deps = buildDeps(config, renderer, adminApi, drainSource);

  const handler = createBrokerHandler(deps);
  const server = createServer((req, res) => void handler(req, res));
  server.headersTimeout = 10_000;
  server.requestTimeout = Math.max(60_000, config.drainPollTimeoutMs + 10_000);
  server.listen(config.port, config.host, () => {
    console.log(`broker listening on ${config.host}:${config.port}`);
  });

  function shutdown(): void {
    const forceExit = setTimeout(() => process.exit(0), 5000);
    forceExit.unref();
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

// Only runs `main()` when this file is the process's actual entrypoint
// (`node dist/server.js`), never when it is merely imported -- by
// server.test.ts, or by anything else that wants `buildDeps`/`loadPlugin`
// without also starting a real listener and registering signal handlers.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err) => {
    console.error(`broker failed to start: ${(err as Error).message}`);
    process.exit(1);
  });
}
