import { join } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createCollectorRuntime } from './collectorLoop.js';
import { createSubmittedTracker, type SubmittedTracker } from './dedupe.js';
import { DescriptorTargetStore } from './descriptorTargets.js';
import { createDrainClient } from './drainClient.js';
import { createDeliveryClient } from './deliveryClient.js';
import { createHealthState } from './health.js';
import { createDeadMansSwitch } from '@branchleft/ghost-platform-deadmans-switch';
import { createLogger } from './log.js';
import { createDirectoryDsnMailbox } from './dsnMailbox.js';
import { createOutcomeRunner } from './outcomeRunner.js';
import { createFailureCounter } from './submissionFailures.js';
import { createSweegoDeliveryClient } from './sweegoDeliveryClient.js';
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

const deliveryClient = createDeliveryClient({
  ...config.smtp,
  ...(config.outcomes ? { outcomes: { returnPath: config.outcomes.returnPath } } : {}),
});

const dedupe = createSubmittedTracker(config.dedupeTtlMs, Date.now, {
  ...(config.dedupeStatePath ? { statePath: config.dedupeStatePath } : {}),
  onError: (error) => log.warn('dedupe_state_error', { error: error.message }),
});
if (!config.dedupeStatePath) {
  log.warn('dedupe_not_persistent', {});
}

// A restart must not forget which target a message first went to: the pin
// has to outlast the shim's retry horizon, so it lives on a volume.
function pinTracker(name: string): SubmittedTracker {
  return createSubmittedTracker(config.pinTtlMs, Date.now, {
    ...(config.pinStateDir ? { statePath: join(config.pinStateDir, name) } : {}),
    onError: (error) => log.warn('pin_state_error', { error: error.message }),
  });
}
const mx1Pins = pinTracker('mx1-pins.json');
const sweegoPins = pinTracker('sweego-pins.json');
if (!config.pinStateDir) {
  log.warn('pins_not_persistent', {});
}

// Present only when the relay is configured. The client reads the credential
// from its file for each message; nothing here holds the value.
const sweegoDeliveryClient = config.sweego
  ? createSweegoDeliveryClient({
      host: config.sweego.host,
      port: config.sweego.port,
      secure: config.sweego.secure,
      user: config.sweego.user,
      passFile: config.sweego.passFile,
      timeoutMs: config.sweego.timeoutMs,
    })
  : undefined;
const sweegoThrottle = config.sweego
  ? createThrottle({
      configPath: config.sweego.throttleConfigPath,
      messagesPerHour: config.sweego.messagesPerHour,
      log,
    })
  : undefined;
const sweegoFailures = createFailureCounter();

const health = createHealthState();

// Ping only once every host the descriptor currently names has reported a
// completed cycle -- never on a timer of this module's own, which would
// keep firing while one host's loop is wedged. `getExpectedTargetIds`
// reads the store's own live target list, never a snapshot, so a
// descriptor change takes effect on the very next reconcile. `shouldPing`
// gates the ping on the SAME health signal a submission failure feeds (see
// health.ts and heartbeat.ts's own header comments): a loop that keeps
// completing cycles but cannot submit anything must go silent too, not
// just one that stops looping outright.
const heartbeat = createDeadMansSwitch({
  url: config.heartbeatUrl,
  log,
  shouldPing: () => health.isHealthy(config.heartbeatFailureThreshold),
  getExpectedTargetIds: () => store.targets.map((t) => t.id),
});

const outcomes = config.outcomes
  ? {
      runner: createOutcomeRunner({
        mailbox: createDirectoryDsnMailbox(config.outcomes.dsnDir),
        store,
        drainClient,
        log,
      }),
      intervalMs: config.outcomes.pollMs,
    }
  : undefined;

const runtime = createCollectorRuntime({
  outcomes,
  store,
  drainClient,
  deliveryClient,
  sweegoDeliveryClient,
  sweegoThrottle,
  sweegoFailures,
  mx1Pins,
  sweegoPins,
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
      sweegoDeliveryClient?.close();
      log.info('worker_lifecycle', { event: 'shutdown_complete' });
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
