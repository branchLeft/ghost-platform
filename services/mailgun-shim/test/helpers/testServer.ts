import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import type { DrainRouterOptions } from '../../src/routes/drain.js';
import { createDrainWake } from '../../src/drainWake.js';
import { createSmtpFrontDoor, type SmtpFrontDoor } from '../../src/smtpFrontDoor.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';
import type { Throttle } from '../../src/throttle.js';
import { createTestLogger } from './testLogger.js';
import { createUnlimitedThrottle } from './testThrottle.js';

export interface TestShim {
  baseUrl: string;
  store: ShimStore;
  drainToken: string;
  /** Only set when `startSmtpFrontDoor` is passed — the SMTP front door's own listen port, sharing this shim's store and wake instance exactly like the real server.ts wires them. */
  smtpPort?: number;
  close(): Promise<void>;
}

export interface StartTestShimOptions {
  dbPath?: string;
  drainOptions?: Partial<DrainRouterOptions>;
  throttle?: Throttle;
  /** Also starts the SMTP front door bound to 127.0.0.1 on a random port, sharing this shim's store and wake — proves the two front doors are genuinely one queue, not just each individually connected to their own. Off by default: most tests only need the HTTP side. */
  startSmtpFrontDoor?: boolean;
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
export async function startTestShim(options: StartTestShimOptions = {}): Promise<TestShim> {
  const store = createSqliteStore(options.dbPath ?? ':memory:');
  const wake = createDrainWake();
  const drainToken = `test-drain-token-${randomUUID()}`;
  const drainOptions: DrainRouterOptions = { ...DEFAULT_DRAIN_OPTIONS, ...options.drainOptions };
  const throttle = options.throttle ?? createUnlimitedThrottle();
  const app = createApp(store, wake, drainToken, drainOptions, throttle);

  const { server, baseUrl } = await new Promise<{ server: Server; baseUrl: string }>(
    (resolve, reject) => {
      const s: Server = app.listen(0, '127.0.0.1', () => {
        const address = s.address() as AddressInfo;
        resolve({ server: s, baseUrl: `http://127.0.0.1:${address.port}` });
      });
      s.on('error', reject);
    }
  );

  let smtpPort: number | undefined;
  let smtpFrontDoor: SmtpFrontDoor | undefined;
  if (options.startSmtpFrontDoor) {
    // Shares `store` and `wake` with the HTTP app above — exactly how
    // server.ts wires the two front doors onto one queue, not two
    // independently-plumbed ones that happen to look alike.
    const { logger } = createTestLogger();
    smtpFrontDoor = createSmtpFrontDoor({
      store,
      wake,
      log: logger,
      maxMessageBytes: 2 * 1024 * 1024,
      maxRecipientsPerMessage: 50,
      maxUnauthenticatedConnectionsPerSource: 20,
      maxUnauthenticatedConnections: 20,
      maxUnauthenticatedPerSourceWaitQueueDepth: 50,
      maxUnauthenticatedPerSourceWaitMs: 2000,
      authDeadlineMs: 5000,
      maxConcurrentDataPhases: 20,
      maxConcurrentDataPhasesPerSubmitter: 5,
      submitterMessagesPerMinute: 120,
    });
    smtpPort = 20000 + Math.floor(Math.random() * 20000);
    await smtpFrontDoor.listen(smtpPort, '127.0.0.1');
  }

  return {
    baseUrl,
    store,
    drainToken,
    smtpPort,
    async close() {
      await smtpFrontDoor?.close();
      await new Promise<void>((res) => server.close(() => res()));
      store.close();
    },
  };
}
