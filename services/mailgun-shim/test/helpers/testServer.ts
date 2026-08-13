import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { createDeliveryTransport } from '../../src/smtp.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';
import type { WorkerHandle } from '../../src/worker.js';
import { createTestLogger } from './testLogger.js';
import { createTestWorker } from './testWorker.js';

export interface TestShim {
  baseUrl: string;
  store: ShimStore;
  worker: WorkerHandle;
  close(): Promise<void>;
}

export function startTestShim(
  smtpPort: number,
  smtpUser: string,
  smtpPass: string
): Promise<TestShim> {
  const store = createSqliteStore(':memory:');
  const transport = createDeliveryTransport({
    host: '127.0.0.1',
    port: smtpPort,
    secure: false,
    auth: { user: smtpUser, pass: smtpPass },
  });
  const { logger } = createTestLogger();
  const worker = createTestWorker(store, transport, { log: logger });
  const app = createApp(store, worker, logger);

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        store,
        worker,
        close() {
          return new Promise((res) => {
            server.close(() => {
              void worker.stop().then(() => res());
            });
          });
        },
      });
    });
    server.on('error', reject);
  });
}
