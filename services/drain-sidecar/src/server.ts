import type { Server } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createFileDrainFlag } from './drainFlag.js';
import { listenOnUnixSocket } from './unixSocket.js';
import { createHttpGhostProbe } from './ghostProbe.js';
import { createHttpGhostVersionProbe } from './versionProbe.js';
import {
  createHttpReachabilityProbe,
  createStaleNamespaceWatch,
  runStaleNamespaceWatch,
} from './staleNamespaceWatchdog.js';

const STALE_WATCH_INTERVAL_MS = 1000;

const config = loadConfig();
const drainFlag = createFileDrainFlag(config.drainFlagPath);
const ghost = createHttpGhostProbe(config.ghostHealthUrl, config.ghostProbeTimeoutMs);
const ghostVersion = createHttpGhostVersionProbe(
  config.ghostAdminSiteUrl,
  config.ghostProbeTimeoutMs
);
const app = createApp(drainFlag, ghost, ghostVersion, config.intendedGhostVersion);

const server = await (config.socketPath === null
  ? new Promise<Server>((resolve) => {
      const listening = app.listen(config.port, () => resolve(listening));
    })
  : listenOnUnixSocket(app, config.socketPath));
console.log(
  `drain-sidecar listening on ${config.socketPath ?? config.port}, flag=${config.drainFlagPath}, ghost=${config.ghostHealthUrl}`
);

// Ghost's address is only ever reached through the network namespace this
// process joined at start. When Docker restarts Ghost it gets a new one and
// this process keeps the dead one, so nothing ever answers again. Exiting
// non-zero lets the restart policy start this container afresh, which joins
// Ghost's current namespace. Off unless the caller sets the variable.
if (config.exitAfterGhostUnreachableMs !== null) {
  const watch = createStaleNamespaceWatch({
    probe: createHttpReachabilityProbe(config.ghostHealthUrl, config.ghostProbeTimeoutMs),
    staleAfterMs: config.exitAfterGhostUnreachableMs,
  });
  runStaleNamespaceWatch(watch, STALE_WATCH_INTERVAL_MS, () => {
    console.error(
      `drain-sidecar: nothing answered at ${config.ghostHealthUrl} for ${config.exitAfterGhostUnreachableMs}ms, exiting to rejoin Ghost's network namespace`
    );
    process.exit(1);
  });
}

function shutdown(): void {
  // A hung keep-alive connection would otherwise stall close() forever;
  // the fallback exit makes SIGTERM's grace period bounded regardless.
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
