import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/app.js';
import { createDeliveryTransport } from '../../src/smtp.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';

export interface TestShim {
  baseUrl: string;
  store: ShimStore;
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
  const app = createApp(store, transport);

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        store,
        close() {
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
    server.on('error', reject);
  });
}
