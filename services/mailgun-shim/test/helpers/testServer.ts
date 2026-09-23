import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import type { DrainRouterOptions } from '../../src/routes/drain.js';
import { createDrainWake } from '../../src/drainWake.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';
import type { Throttle } from '../../src/throttle.js';
import { createUnlimitedThrottle } from './testThrottle.js';

export interface TestShim {
  baseUrl: string;
  store: ShimStore;
  drainToken: string;
  close(): Promise<void>;
}

export interface StartTestShimOptions {
  dbPath?: string;
  drainOptions?: Partial<DrainRouterOptions>;
  throttle?: Throttle;
}

const DEFAULT_DRAIN_OPTIONS: DrainRouterOptions = {
  holdMs: 200,
  leaseSeconds: 5,
  batchLimit: 25,
  pollIntervalMs: 20,
};

/**
 * Starts a real shim: the real app, a real sqlite store (in-memory unless
 * `dbPath` is given), and a real drain handover — nothing about the drain
 * contract itself is faked. What stands in for the estate is only what is
 * genuinely outside this service's own boundary: the collector on the
 * other end of GET /drain (test/helpers/collector.ts) and the delivery
 * host it forwards to (test/helpers/smtpSink.ts).
 */
export function startTestShim(options: StartTestShimOptions = {}): Promise<TestShim> {
  const store = createSqliteStore(options.dbPath ?? ':memory:');
  const wake = createDrainWake();
  const drainToken = `test-drain-token-${randomUUID()}`;
  const drainOptions: DrainRouterOptions = { ...DEFAULT_DRAIN_OPTIONS, ...options.drainOptions };
  const throttle = options.throttle ?? createUnlimitedThrottle();
  const app = createApp(store, wake, drainToken, drainOptions, throttle);

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        store,
        drainToken,
        close() {
          return new Promise((res) => {
            server.close(() => {
              store.close();
              res();
            });
          });
        },
      });
    });
    server.on('error', reject);
  });
}
