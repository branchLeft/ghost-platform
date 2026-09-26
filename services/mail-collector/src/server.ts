import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createCollectorRuntime } from './collectorLoop.js';
import { createDeliveredTracker } from './dedupe.js';
import { DescriptorTargetStore } from './descriptorTargets.js';
import { createDrainClient } from './drainClient.js';
import { createDeliveryClient } from './deliveryClient.js';
import { startHeartbeat } from './heartbeat.js';
import { createLogger } from './log.js';
import { createThrottle } from './throttle.js';

const config = loadConfig();
const log = createLogger();

const store = new DescriptorTargetStore({
  descriptorDir: config.descriptorDir,
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

const dedupe = createDeliveredTracker(config.dedupeTtlMs);

const runtime = createCollectorRuntime({
  store,
  drainClient,
  deliveryClient,
  throttle,
  dedupe,
  log,
  descriptorRefreshMs: config.descriptorRefreshMs,
  drainRetryBackoffMs: config.drainRetryBackoffMs,
  emptyPollBackoffMs: config.emptyPollBackoffMs,
});

const heartbeat = startHeartbeat({
  url: config.heartbeatUrl,
  intervalMs: config.heartbeatIntervalMs,
  log,
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
  heartbeat.stop();
  server.close(() => {
    void runtime.stop().then(() => {
      deliveryClient.close();
      log.info('worker_lifecycle', { event: 'shutdown_complete' });
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
