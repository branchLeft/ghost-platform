import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createDeliveryTransport } from './smtp.js';
import { createSqliteStore } from './store.js';
import { createThrottle } from './throttle.js';
import { createWorker } from './worker.js';

const config = loadConfig();
const log = createLogger();
const store = createSqliteStore(config.dbPath);
const transport = createDeliveryTransport(config.smtp);
const throttle = createThrottle({
  configPath: config.throttlePath,
  envMessagesPerHour: config.messagesPerHour,
  log,
});

// Constructing the worker starts its startup drain immediately — this is
// deliberately before app.listen() below, not after: a batch left pending
// by a crashed previous process should not wait for the first HTTP request
// to be picked back up.
const worker = createWorker({ store, transport, throttle, log });

const app = createApp(store, worker, log);

const server = app.listen(config.port, () => {
  log.info('worker_lifecycle', { event: 'listening', port: config.port });
});

function shutdown(signal: string): void {
  log.info('worker_lifecycle', { event: 'shutdown_start', signal });
  server.close(() => {
    void worker.stop().then(() => {
      store.close();
      log.info('worker_lifecycle', { event: 'shutdown_complete' });
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
