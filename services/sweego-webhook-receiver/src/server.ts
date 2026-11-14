import { loadConfig } from './config.js';

import { createDrainServer } from './drain.js';
import { createLogger } from './log.js';
import { openQueue } from './queue.js';
import { openReplayStore } from './replay.js';
import { createStats } from './stats.js';
import { createWebhookServer } from './webhook.js';

const config = loadConfig(process.env);
const log = createLogger();
const queue = openQueue(config.stateDir);
const replay = openReplayStore(config.stateDir, Date.now);
const stats = createStats();

const timeouts = {
  headersTimeoutMs: config.headersTimeoutMs,
  requestTimeoutMs: config.requestTimeoutMs,
  keepAliveTimeoutMs: config.keepAliveTimeoutMs,
  // The check interval is Node's default in production; only a test shortens it.
  ...(process.env['WEBHOOK_CHECK_INTERVAL_MS'] === undefined
    ? {}
    : { checkIntervalMs: Number(process.env['WEBHOOK_CHECK_INTERVAL_MS']) }),
};

const webhookServer = createWebhookServer(
  {
    secrets: config.secrets,
    queue,
    replay,
    stats,
    now: Date.now,
    log,
    ...(config.outcomeHeader === undefined ? {} : { outcomeHeader: config.outcomeHeader }),
  },
  timeouts
);
const drainServer = createDrainServer({ queue, stats, log, token: config.drainToken }, timeouts);

webhookServer.listen(config.port, config.host, () => {
  log.info('worker_lifecycle', {
    event: 'webhook_listening',
    host: config.host,
    port: config.port,
  });
});
drainServer.listen(config.drainPort, config.drainHost, () => {
  log.info('worker_lifecycle', {
    event: 'drain_listening',
    host: config.drainHost,
    port: config.drainPort,
  });
});

function shutdown(signal: string): void {
  log.info('worker_lifecycle', { event: 'shutdown_start', signal });
  drainServer.close();
  webhookServer.close(() => {
    queue.close();
    replay.close();
    log.info('worker_lifecycle', { event: 'shutdown_complete' });
    process.exit(0);
  });
  webhookServer.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
