import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBrokerHandler, type BrokerDeps } from './app.js';
import type { AdminApiClient } from './adminApi.js';
import { createInMemoryNonceStore } from './nonceStore.js';
import { loadConfig, type BrokerConfig, type BrokerEnv } from './config.js';
import { createDrainFlagStore } from './drainFlag.js';
import type { DrainSource } from './drainSource.js';
import { createSudoEmailBatchChecker, type EmailBatchChecker } from './emailBatchChecker.js';
import { createHttpGhostReadinessChecker } from './ghostReadiness.js';
import { createHttpHealthChecker } from './healthCheck.js';
import type { ImageLoader } from './imagePush.js';
import { createFileRealTrafficChecker, createZeroRealTrafficChecker } from './realTraffic.js';
import type { Renderer } from './render.js';
import { createSlotLock } from './slotLock.js';
import { standInSeams } from './standIns.js';
import { recoverCrashedSlots } from './stateStore.js';
import { createSlotWrapper } from './wrapper.js';

function isEmailBatchChecker(candidate: unknown): candidate is EmailBatchChecker {
  return (
    typeof (candidate as Partial<EmailBatchChecker> | undefined)?.hasSubmittingBatch === 'function'
  );
}

function isRenderer(candidate: unknown): candidate is Renderer {
  return typeof (candidate as Partial<Renderer> | undefined)?.render === 'function';
}
function isAdminApiClient(candidate: unknown): candidate is AdminApiClient {
  return typeof (candidate as Partial<AdminApiClient> | undefined)?.configure === 'function';
}
function isDrainSource(candidate: unknown): candidate is DrainSource {
  return typeof (candidate as Partial<DrainSource> | undefined)?.poll === 'function';
}
function isImageLoader(candidate: unknown): candidate is ImageLoader {
  return typeof (candidate as Partial<ImageLoader> | undefined)?.load === 'function';
}

/**
 * `Renderer`, `AdminApiClient`, `DrainSource` and `ImageLoader` are all
 * loaded as plugin modules rather than built into this entrypoint, so a
 * fake implementation cannot silently pass its own tests while doing
 * nothing real in production. Refuses to start if a module is missing *or
 * if its default export does not have the seam's required function* --
 * failing loudly rather than reaching the handler as `undefined`.
 * See server.md#loadplugin.
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
 * The whole of how a loaded config and the four plugin seams become the
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
  drainSource: DrainSource,
  imageLoader: ImageLoader
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
    standIns: standInSeams({ renderer, adminApi, drainSource, imageLoader }),
    leaseStoreConfig: {
      slotsPath: config.slotsPath,
      leaseDir: config.leaseDir,
      nowMs: config.nowMs,
    },
    drainFlags: createDrainFlagStore(config.drainFlagDir),
    imagePush: {
      loader: imageLoader,
      tmpDir: config.imageTmpDir,
      maxBytes: config.imageMaxBytes,
      nowMs: config.nowMs,
      log: (line) => console.error(line),
    },
    healthChecker: createHttpHealthChecker('127.0.0.1', config.healthCheckTimeoutMs),
    ghostReadiness: createHttpGhostReadinessChecker('127.0.0.1', config.healthCheckTimeoutMs),
    // `realTraffic` defaults to the fail-closed side of the stop-old-colour
    // pre-stop gate: absent configuration must never read as "safe to
    // stop" (see `createZeroRealTrafficChecker`'s own doc comment).
    // `emailBatchChecker`'s real implementation is itself fail-closed on
    // every error path (`createSudoEmailBatchChecker`'s own doc comment),
    // so wiring it unconditionally here, rather than behind a config flag
    // like `trafficCounterDir`, is safe: an unconfigured or unreachable
    // wrapper still refuses to stop, exactly like the old placeholder did.
    realTraffic: config.trafficCounterDir
      ? createFileRealTrafficChecker(config.trafficCounterDir)
      : createZeroRealTrafficChecker(),
    emailBatchChecker: createSudoEmailBatchChecker(
      {
        command: config.wrapperCommand,
        prefix: config.wrapperPrefix,
        timeoutMs: config.wrapperTimeoutMs,
      },
      (line) => console.error(line)
    ),
    ghostReadyPollTimeoutMs: config.ghostReadyPollTimeoutMs,
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
  await mkdir(config.imageTmpDir, { recursive: true });
  if (config.trafficCounterDir) {
    await mkdir(config.trafficCounterDir, { recursive: true });
  }

  // Before anything below can accept a request: a slot a previous process
  // left `preparing`/`resetting`/`swapping`/`stopping` had its lock holder
  // die with it (the lock is in-memory and this is a fresh process), so it
  // cannot be trusted as still in flight. See `recoverCrashedSlots`'s,
  // `recoverSwapInFlight`'s and `recoverStoppingSlot`'s own doc comments
  // for what each phase needs.
  await recoverCrashedSlots(
    config.stateDir,
    config.slotLiterals,
    { slotsPath: config.slotsPath, leaseDir: config.leaseDir },
    (line) => console.error(line),
    {
      drainFlags: createDrainFlagStore(config.drainFlagDir),
      ghostReadiness: createHttpGhostReadinessChecker('127.0.0.1', config.healthCheckTimeoutMs),
      appPortBase: config.appPortBase,
      // The swap's own bring-up budget, not a shorter one: recovery polls
      // exactly the same way `attemptColourSwap` itself does, for the same
      // reason (`ghostReadiness.ts`'s own doc comment on Ghost's post-boot
      // maintenance window).
      readyPollTimeoutMs: config.ghostReadyPollTimeoutMs,
    },
    {
      wrapper: createSlotWrapper({
        command: config.wrapperCommand,
        prefix: config.wrapperPrefix,
        timeoutMs: config.wrapperTimeoutMs,
      }),
    }
  );

  const renderer = await loadPlugin('BROKER_RENDERER_MODULE', process.env, isRenderer);
  const adminApi = await loadPlugin('BROKER_ADMIN_API_MODULE', process.env, isAdminApiClient);
  const drainSource = await loadPlugin('BROKER_DRAIN_SOURCE_MODULE', process.env, isDrainSource);
  const imageLoader = await loadPlugin('BROKER_IMAGE_LOADER_MODULE', process.env, isImageLoader);

  let deps = buildDeps(config, renderer, adminApi, drainSource, imageLoader);

  // Optional fifth seam, deliberately not required at start-up the way
  // the four above are: `buildDeps` already wires `createSudoEmailBatchChecker`
  // as the real default (`emailBatchChecker.ts`'s own doc comment), and this
  // override exists only for a deploy that wants something else entirely --
  // never for "no real implementation exists yet", which is no longer true.
  if (process.env.BROKER_EMAIL_BATCH_CHECKER_MODULE) {
    const emailBatchChecker = await loadPlugin(
      'BROKER_EMAIL_BATCH_CHECKER_MODULE',
      process.env,
      isEmailBatchChecker
    );
    deps = { ...deps, emailBatchChecker };
  }

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
