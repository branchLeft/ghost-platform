'use strict';

const { VerdictQueue } = require('./queue');
const { createAuthenticator, loadVerifyKey } = require('./auth');
const { startLocalSocket } = require('./local-socket');
const { startInbound } = require('./inbound');
const { HostMetrics } = require('./metrics');
const { startTextfileExport } = require('../src/metrics');

// Wires the host end together. It builds no client of any kind: the only
// sockets it ever has are the two it listens on. Behaviour: verdict-host.md.

const SWEEP_INTERVAL_MS = 5000;

async function startVerdictHost(config, { logger = console, now = Date.now, egressRefused } = {}) {
  const queue = new VerdictQueue({
    journalFile: config.journalFile,
    now,
    leaseMs: config.leaseMs,
    reofferDelayMs: config.reofferDelayMs,
    verdictTtlMs: config.verdictTtlMs,
    maxQueued: config.maxQueued,
    logger,
  }).open();

  const metrics = new HostMetrics({ queue, now, egressRefused });
  const authenticate = createAuthenticator({
    publicKey: loadVerifyKey(config.verifyKeyFile),
    replayWindowSeconds: config.replayWindowSeconds,
    now,
  });

  const local = await startLocalSocket({
    queue,
    socketPath: config.socketPath,
    socketMode: config.socketMode,
    askWaitMs: config.askWaitMs,
    onAsk: (result) => metrics.count('asks', result),
  });
  const inbound = await startInbound({
    queue,
    authenticate,
    host: config.inboundHost,
    port: config.inboundPort,
    holdMs: config.holdMs,
    now,
    logger,
    count: (family, value) => metrics.count(family, value),
  });

  const stopExport = startTextfileExport(metrics, { filePath: config.metricsFile, logger });
  const sweeper = setInterval(() => queue.sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref();

  return {
    queue,
    metrics,
    local,
    inbound,
    async stop() {
      clearInterval(sweeper);
      stopExport();
      await Promise.all([local.close(), inbound.close()]);
      queue.close();
    },
  };
}

module.exports = { startVerdictHost };
