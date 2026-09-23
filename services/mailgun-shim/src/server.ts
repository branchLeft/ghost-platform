import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDrainWake } from './drainWake.js';
import { createLogger } from './log.js';
import { createSqliteStore } from './store.js';

const config = loadConfig();
const log = createLogger();
const store = createSqliteStore(config.dbPath);
const wake = createDrainWake();

const app = createApp(
  store,
  wake,
  config.drainToken,
  {
    holdMs: config.drainHoldMs,
    leaseSeconds: config.drainLeaseSeconds,
    batchLimit: config.drainBatchLimit,
    pollIntervalMs: config.drainPollIntervalMs,
  },
  log
);

const server = app.listen(config.port, () => {
  log.info('worker_lifecycle', { event: 'listening', port: config.port });
});

function shutdown(signal: string): void {
  log.info('worker_lifecycle', { event: 'shutdown_start', signal });
  server.close(() => {
    store.close();
    log.info('worker_lifecycle', { event: 'shutdown_complete' });
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
