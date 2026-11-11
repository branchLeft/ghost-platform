import { join } from 'node:path';
import { createApp } from './app.js';
import { loadConfig, sweegoUsable } from './config.js';
import { createCollectorRuntime } from './collectorLoop.js';
import { createSubmittedTracker, type SubmittedTracker } from './dedupe.js';
import { DescriptorTargetStore } from './descriptorTargets.js';
import { createDrainClient } from './drainClient.js';
import { createDroppedOutcomes } from './droppedOutcomes.js';
import { createDeliveryClient } from './deliveryClient.js';
import { createHealthState } from './health.js';
import { createDeadMansSwitch } from '@branchleft/ghost-platform-deadmans-switch';
import { createLogger } from './log.js';
import { createDirectoryDsnMailbox } from './dsnMailbox.js';
import { createOutcomeRunner } from './outcomeRunner.js';
import { createFailureCounter } from './submissionFailures.js';
import { createSweegoDeliveryClient } from './sweegoDeliveryClient.js';
import { createSweegoUsage } from './sweegoUsage.js';
import { createThrottle } from './throttle.js';
import { createBulkCap } from './lanes.js';

const config = loadConfig();
const log = createLogger();

const store = new DescriptorTargetStore({
  descriptorDir: config.descriptorDir,
  shimScheme: config.shimScheme,
  shimPort: config.shimPort,
  maxStalenessMs: config.descriptorMaxStalenessMs,
  log,
  ...(config.demoMailDomain ? { demoMailDomain: config.demoMailDomain } : {}),
});
if (!config.demoMailDomain) {
  // Only a demo host is affected: its mail is held until the domain is set.
  log.warn('demo_mail_domain_not_set', {});
}

const bulkCap = createBulkCap({
  rampPath: config.bulkRampPath,
  ...(config.bulkDeferralStatePath ? { deferralStatePath: config.bulkDeferralStatePath } : {}),
  onStateError: (error) => log.warn('bulk_deferral_state_error', { error: error.message }),
  log,
});

const throttle = createThrottle({
  configPath: config.throttleConfigPath,
  messagesPerHour: config.messagesPerHour,
  log,
  rateFor: (configured, nowMs) => bulkCap.rateFor(configured, nowMs),
});

const loginThrottle = createThrottle({
  messagesPerHour: config.loginMessagesPerHour,
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
const sweegoAmbiguous = pinTracker('sweego-ambiguous.json');
if (!config.pinStateDir) {
  log.warn('pins_not_persistent', {});
}

// Present only when the relay, the account-wide cap and the counter file are
// all configured: with any one missing nothing could hold the total inside the
// plan, so Sweego is not used and every message goes through mx1. The client
// reads the credential from its file for each message; nothing here holds the
// value.
const sweegoConfig = sweegoUsable(config.sweego) ? config.sweego : undefined;
if (config.sweego && !sweegoConfig) {
  log.warn('sweego_not_configured', { reason: 'account_cap_or_usage_state_missing' });
}
const sweegoDeliveryClient = sweegoConfig
  ? createSweegoDeliveryClient({
      host: sweegoConfig.host,
      port: sweegoConfig.port,
      secure: sweegoConfig.secure,
      user: sweegoConfig.user,
      passFile: sweegoConfig.passFile,
      timeoutMs: sweegoConfig.timeoutMs,
    })
  : undefined;
const sweegoThrottle = sweegoConfig
  ? createThrottle({
      configPath: sweegoConfig.throttleConfigPath,
      messagesPerHour: sweegoConfig.messagesPerHour,
      log,
    })
  : undefined;
const sweegoFailures = createFailureCounter();
// The counter is the quota the resolver asks. The allowance it checks is the
// one the tenant's route carries, read from the live descriptor list. The
// reasons it counts name no tenant, so they can be logged as they are.
const sweegoUsage = sweegoConfig
  ? createSweegoUsage({
      statePath: sweegoConfig.usageStatePath,
      accountCap: sweegoConfig.accountCap,
      allowanceOf: (tenantId) => store.targets.find((t) => t.id === tenantId)?.sweegoAllowance,
      onReason: (reason) => log.warn('sweego_usage', { reason }),
    })
  : undefined;

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

// A recipient Sweego refuses for good is acked and dropped; this tells the
// spool, on its existing outcome route, so Ghost shows the failure and the
// address is suppressed. A spool that has not opted in answers 404: logged,
// tried again, then given up on.
const droppedOutcomes = createDroppedOutcomes({ client: drainClient, log });

const runtime = createCollectorRuntime({
  outcomes,
  droppedOutcomes,
  store,
  drainClient,
  deliveryClient,
  sweegoDeliveryClient,
  sweegoThrottle,
  sweegoFailures,
  enforceHeaderFrom: true,
  sweegoQuota: sweegoUsage,
  mx1Pins,
  sweegoPins,
  sweegoAmbiguous,
  throttle,
  loginThrottle,
  bulkCap,
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
