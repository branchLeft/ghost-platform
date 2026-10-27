import { createApp, createDrainApp, createMailApp } from './app.js';
import { startCleanupScheduler } from './cleanup.js';
import { loadConfig } from './config.js';
import { createDrainWake } from './drainWake.js';
import { createLogger } from './log.js';
import { createSmtpFrontDoor } from './smtpFrontDoor.js';
import { createSqliteStore } from './store.js';
import { createThrottle } from './throttle.js';

const config = loadConfig();
const log = createLogger();
const store = createSqliteStore(config.dbPath);
const wake = createDrainWake();
const throttle = createThrottle({
  configPath: config.throttlePath,
  envMessagesPerHour: config.messagesPerHour,
  log,
});
const cleanup = startCleanupScheduler(store, log);

const drainOptions = {
  holdMs: config.drainHoldMs,
  leaseSeconds: config.drainLeaseSeconds,
  batchLimit: config.drainBatchLimit,
  pollIntervalMs: config.drainPollIntervalMs,
  outcomesEnabled: config.drainOutcomesEnabled,
};

// With a drain port the handover has a listener of its own and the mail API
// listener has no /drain route; without one both share the single listener.
const app =
  config.drainPort === undefined
    ? createApp(store, wake, config.drainToken, drainOptions, throttle, log)
    : createMailApp(store, wake, log);
const drainApp =
  config.drainPort === undefined
    ? undefined
    : createDrainApp(store, wake, config.drainToken, drainOptions, throttle, log);

const smtpFrontDoor = createSmtpFrontDoor({
  store,
  wake,
  log,
  maxMessageBytes: config.smtpFrontDoor.maxMessageBytes,
  maxRecipientsPerMessage: config.maxRecipientsPerMessage,
  maxUnauthenticatedConnectionsPerSource:
    config.smtpFrontDoor.maxUnauthenticatedConnectionsPerSource,
  maxUnauthenticatedConnections: config.smtpFrontDoor.maxUnauthenticatedConnections,
  maxUnauthenticatedPerSourceWaitQueueDepth:
    config.smtpFrontDoor.maxUnauthenticatedPerSourceWaitQueueDepth,
  maxUnauthenticatedPerSourceWaitMs: config.smtpFrontDoor.maxUnauthenticatedPerSourceWaitMs,
  authDeadlineMs: config.smtpFrontDoor.authDeadlineMs,
  maxConcurrentDataPhases: config.smtpFrontDoor.maxConcurrentDataPhases,
  maxConcurrentDataPhasesPerSubmitter: config.smtpFrontDoor.maxConcurrentDataPhasesPerSubmitter,
  allowedSourceCidrs: config.smtpFrontDoor.allowedSourceCidrs,
  submitterMessagesPerMinute: config.smtpFrontDoor.submitterMessagesPerMinute,
});
void smtpFrontDoor.listen(config.smtpFrontDoor.port, config.smtpFrontDoor.host);

const drainServer =
  drainApp &&
  drainApp.listen(config.drainPort, () => {
    log.info('worker_lifecycle', { event: 'drain_listening', port: config.drainPort });
  });

const server = app.listen(config.port, () => {
  log.info('worker_lifecycle', { event: 'listening', port: config.port });
});

function shutdown(signal: string): void {
  log.info('worker_lifecycle', { event: 'shutdown_start', signal });
  cleanup.stop();
  drainServer?.close();
  server.close(() => {
    void smtpFrontDoor.close().then(() => {
      store.close();
      log.info('worker_lifecycle', { event: 'shutdown_complete' });
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
