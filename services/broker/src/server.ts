import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createBrokerHandler, type BrokerDeps } from './app.js';
import type { AdminApiClient } from './adminApi.js';
import { createInMemoryNonceStore } from './nonceStore.js';
import { loadConfig, type BrokerEnv } from './config.js';
import { createDrainFlagStore } from './drainFlag.js';
import type { DrainSource } from './drainSource.js';
import { createHttpHealthChecker } from './healthCheck.js';
import type { Renderer } from './render.js';
import { createSlotWrapper } from './wrapper.js';

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
 * is missing, so "not wired yet" fails loudly instead of serving 200s that
 * mean nothing.
 */
async function loadPlugin<T>(envVar: string, env: BrokerEnv): Promise<T> {
  const modulePath = env[envVar];
  if (!modulePath) {
    throw new Error(
      `${envVar} is not set. This service has no default ${envVar.replace('BROKER_', '').replace('_MODULE', '')} -- see the doc comment on the seam's own interface file for why, and point ${envVar} at a module whose default export implements it.`
    );
  }
  const mod = (await import(modulePath)) as { default: T };
  return mod.default;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  await mkdir(config.stateDir, { recursive: true });
  await mkdir(config.drainFlagDir, { recursive: true });
  await mkdir(config.leaseDir, { recursive: true });

  const renderer = await loadPlugin<Renderer>('BROKER_RENDERER_MODULE', process.env);
  const adminApi = await loadPlugin<AdminApiClient>('BROKER_ADMIN_API_MODULE', process.env);
  const drainSource = await loadPlugin<DrainSource>('BROKER_DRAIN_SOURCE_MODULE', process.env);

  const deps: BrokerDeps = {
    auth: {
      verifyKey: config.verifyKey,
      replayWindowSeconds: config.replayWindowSeconds,
      nonces: createInMemoryNonceStore(config.replayWindowSeconds * 1000),
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
    slotDirBase: config.slotDirBase,
    stateDir: config.stateDir,
    drainPollTimeoutMs: config.drainPollTimeoutMs,
    nowMs: config.nowMs,
    log: (line) => console.error(line),
  };

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
}

main().catch((err) => {
  console.error(`broker failed to start: ${(err as Error).message}`);
  process.exit(1);
});
