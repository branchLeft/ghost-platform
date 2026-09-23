import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createFileDrainFlag } from './drainFlag.js';
import { createHttpGhostProbe } from './ghostProbe.js';

const config = loadConfig();
const drainFlag = createFileDrainFlag(config.drainFlagPath);
const ghost = createHttpGhostProbe(config.ghostHealthUrl, config.ghostProbeTimeoutMs);
const app = createApp(drainFlag, ghost);

const server = app.listen(config.port, () => {
  console.log(
    `drain-sidecar listening on ${config.port}, flag=${config.drainFlagPath}, ghost=${config.ghostHealthUrl}`
  );
});

function shutdown(): void {
  // A hung keep-alive connection would otherwise stall close() forever;
  // the fallback exit makes SIGTERM's grace period bounded regardless.
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
