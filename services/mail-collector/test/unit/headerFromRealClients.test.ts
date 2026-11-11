import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDeliveryClient } from '../../src/deliveryClient.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { createSweegoDeliveryClient } from '../../src/sweegoDeliveryClient.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import { startFakeSweegoRelay, type FakeRelay } from '../helpers/fakeSweegoRelay.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';
import {
  DRAIN_TOKEN,
  NEWSLETTER,
  QUOTA_FREE,
  countingThrottle,
  settle,
  until,
} from '../helpers/loopHarness.js';

const RELAY_USER = 'RELAY_USER_PLACEHOLDER';
const RELAY_PASS = 'relay-pass-real-clients-placeholder';

/**
 * The same check as headerFromLoop.test.ts, through the real delivery clients
 * and the stand-ins for mx1 and the Sweego relay: what reaches the far end of
 * each socket, not what a double was asked to send.
 */
describe('the header From check, seen from the far end of each real delivery client', () => {
  let shim: FakeShimServer;
  let baseUrl: string;
  let sink: SmtpSink;
  let relay: FakeRelay;
  let dir: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    shim = new FakeShimServer(DRAIN_TOKEN);
    baseUrl = await shim.listen();
    sink = await startSmtpSink('collector', 'sink-secret');
    relay = await startFakeSweegoRelay(RELAY_USER, RELAY_PASS);
    dir = mkdtempSync(join(tmpdir(), 'collector-header-from-'));
    writeFileSync(join(dir, 'relay-credential'), RELAY_PASS, { mode: 0o600 });
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    await shim.close();
    await sink.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function start(route: DrainTarget['route']) {
    const runtime = createCollectorRuntime({
      store: createFakeTargetStore([
        {
          id: 'tenant-a',
          baseUrl,
          route,
          ...(route === 'sweego' ? { sweegoAllowance: 100 } : {}),
          sendingDomain: 'tenant-a.example',
        },
      ]),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: createDeliveryClient({
        host: '127.0.0.1',
        port: sink.port,
        secure: false,
        user: 'collector',
        pass: 'sink-secret',
      }),
      sweegoDeliveryClient: createSweegoDeliveryClient({
        host: '127.0.0.1',
        port: relay.port,
        secure: false,
        user: RELAY_USER,
        passFile: join(dir, 'relay-credential'),
        timeoutMs: 5000,
        requireTls: false,
      }),
      sweegoThrottle: countingThrottle(),
      sweegoQuota: QUOTA_FREE,
      enforceHeaderFrom: true,
      throttle: countingThrottle(),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    stop = () => runtime.stop();
  }

  const acked = (): string[] => shim.ackRequests.flat().map((ack) => ack.id);

  it.each(['mx1', 'sweego'] as const)(
    'on the %s route a forged From reaches neither mx1 nor the relay, and the in-scope one reaches only its own',
    async (route) => {
      shim.enqueue({
        ...NEWSLETTER('forged'),
        from: 'hello@main.example',
        domain: 'tenant-a.example',
      });
      shim.enqueue({
        ...NEWSLETTER('genuine'),
        from: 'hello@tenant-a.example',
        domain: 'tenant-a.example',
      });
      start(route);
      await until(() => acked().includes('forged') && acked().includes('genuine'), 'both acked');
      await settle();
      const reached = route === 'sweego' ? relay.accepted.length : sink.messages.length;
      const untouched = route === 'sweego' ? sink.messages.length : relay.accepted.length;
      expect(reached).toBe(1);
      expect(untouched).toBe(0);
      if (route === 'mx1') {
        expect(sink.messages[0]?.parsed.from?.value.map((a) => a.address)).toEqual([
          'hello@tenant-a.example',
        ]);
      }
    }
  );
});
