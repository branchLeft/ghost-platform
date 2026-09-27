import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createCollectorRuntime } from './collectorLoop.js';
import { createSubmittedTracker } from './dedupe.js';
import { DescriptorTargetStore } from './descriptorTargets.js';
import { createDrainClient } from './drainClient.js';
import { createDeliveryClient } from './deliveryClient.js';
import { createHealthState } from './health.js';
import { createDeadMansSwitch } from './heartbeat.js';
import { createLogger } from './log.js';
import { createThrottle } from './throttle.js';

const config = loadConfig();
const log = createLogger();

const store = new DescriptorTargetStore({
  descriptorDir: config.descriptorDir,
  shimScheme: config.shimScheme,
  shimPort: config.shimPort,
  maxStalenessMs: config.descriptorMaxStalenessMs,
  log,
});

const throttle = createThrottle({
  configPath: config.throttleConfigPath,
  messagesPerHour: config.messagesPerHour,
  log,
});

const drainClient = createDrainClient({
  drainToken: config.drainToken,
  drainTimeoutMs: config.drainTimeoutMs,
});

const deliveryClient = createDeliveryClient(config.smtp);

const dedupe = createSubmittedTracker(config.dedupeTtlMs);

const health = createHealthState();

// Ping only after this worker's own loop reports a completed cycle -- never
// on a timer of this module's own, which would keep firing while the loop
// is wedged. `shouldPing` gates the ping on the SAME health signal a
// submission failure feeds (see health.ts and heartbeat.ts's own header
// comments): a loop that keeps completing cycles but cannot submit
// anything must go silent too, not just one that stops looping outright.
const heartbeat = createDeadMansSwitch({
  url: config.heartbeatUrl,
  log,
  shouldPing: () => health.isHealthy(config.heartbeatFailureThreshold),
});

const runtime = createCollectorRuntime({
  store,
  drainClient,
  deliveryClient,
  throttle,
  dedupe,
  health,
  heartbeat,
  log,
  descriptorRefreshMs: config.descriptorRefreshMs,
  drainRetryBackoffMs: config.drainRetryBackoffMs,
  emptyPollBackoffMs: config.emptyPollBackoffMs,
});

// The initial descriptor read happens before the first drain attempt, so
// the very first pass already has a real target list rather than the
// empty one `targets` answers before any refresh has ever succeeded.
await store.refresh();
runtime.start();

const app = createApp(store);
const server = app.listen(config.port, () => {
  log.info('worker_lifecycle', { event: 'listening', port: config.port });
});

function shutdown(signal: string): void {
  log.info('worker_lifecycle', { event: 'shutdown_start', signal });
  // Nothing to stop here -- createDeadMansSwitch runs no timer of its own;
  // it simply stops being called once runtime.stop() below retires every
  // target loop.
  server.close(() => {
    void runtime.stop().then(() => {
      deliveryClient.close();
      log.info('worker_lifecycle', { event: 'shutdown_complete' });
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
