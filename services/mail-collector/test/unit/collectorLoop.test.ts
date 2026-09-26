import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createDeliveredTracker } from '../../src/dedupe.js';
import { createDrainClient, type DrainAck, type DrainClient } from '../../src/drainClient.js';
import { createDeliveryClient } from '../../src/deliveryClient.js';
import { createThrottle } from '../../src/throttle.js';
import { createLogger } from '../../src/log.js';
import { FakeShimServer, type QueuedMessage } from '../helpers/fakeShimServer.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';

const DRAIN_TOKEN = 'estate-drain-token';

function message(id: string, overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id,
    domain: 'tenant.example',
    emailId: null,
    from: 'noreply@tenant.example',
    to: `reader-${id}@example.com`,
    subject: `Subject ${id}`,
    html: `<p>${id}</p>`,
    text: id,
    headers: {},
    ...overrides,
  };
}

describe('collector loop -- against real local shim servers and a real SMTP sink', () => {
  let shimA: FakeShimServer;
  let shimB: FakeShimServer;
  let shimUndescribed: FakeShimServer; // reachable, but never named by any target -- the sabotage control case
  let baseUrlA: string;
  let baseUrlB: string;
  let sink: SmtpSink;

  beforeEach(async () => {
    shimA = new FakeShimServer(DRAIN_TOKEN);
    shimB = new FakeShimServer(DRAIN_TOKEN);
    shimUndescribed = new FakeShimServer(DRAIN_TOKEN);
    [baseUrlA, baseUrlB] = await Promise.all([
      shimA.listen(),
      shimB.listen(),
      shimUndescribed.listen(),
    ]);
    sink = await startSmtpSink('collector', 'sink-secret');
  });

  afterEach(async () => {
    await Promise.all([shimA.close(), shimB.close(), shimUndescribed.close()]);
    await sink.close();
  });

  function buildRuntime(targets: DrainTarget[], overrides: { drainClient?: DrainClient } = {}) {
    const store = createFakeTargetStore(targets);
    const drainClient =
      overrides.drainClient ?? createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    const deliveryClient = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'sink-secret',
    });
    const throttle = createThrottle({ messagesPerHour: 360_000 }); // generous -- not the throttle test's job
    const dedupe = createDeliveredTracker(60_000);
    const log = createLogger(() => {});
    const runtime = createCollectorRuntime({
      store,
      drainClient,
      deliveryClient,
      throttle,
      dedupe,
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    return { runtime, store, deliveryClient, dedupe };
  }

  it('a message enqueued on a described host reaches the sink within a second', async () => {
    shimA.enqueue(message('m1'));
    const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }]);
    const startedAt = Date.now();
    runtime.start();
    const [received] = await sink.waitForCount(1, 1000);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(received!.envelopeTo).toEqual(['reader-m1@example.com']);
    await runtime.stop();
    deliveryClient.close();
  });

  it('drains every described host, not just the first', async () => {
    shimA.enqueue(message('from-a'));
    shimB.enqueue(message('from-b'));
    const { runtime, deliveryClient } = buildRuntime([
      { id: 'tenant-a', baseUrl: baseUrlA },
      { id: 'tenant-b', baseUrl: baseUrlB },
    ]);
    runtime.start();
    const received = await sink.waitForCount(2, 2000);
    expect(received.map((r) => r.envelopeTo[0]).sort()).toEqual([
      'reader-from-a@example.com',
      'reader-from-b@example.com',
    ]);
    await runtime.stop();
    deliveryClient.close();
  });

  it('CONTROL CASE: a host reachable on the network but absent from the target list is never drained', async () => {
    shimUndescribed.enqueue(message('should-never-arrive'));
    shimA.enqueue(message('from-a'));
    const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }]);
    runtime.start();
    await sink.waitForCount(1, 1000); // the described host's message does arrive
    await new Promise((r) => setTimeout(r, 300)); // give the undescribed host every chance to be reached anyway
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]!.envelopeTo).toEqual(['reader-from-a@example.com']);
    expect(shimUndescribed.drainRequests).toHaveLength(0); // never even polled
    await runtime.stop();
    deliveryClient.close();
  });

  it('a host removed from the target list mid-run stops being drained', async () => {
    const { runtime, store, deliveryClient } = buildRuntime([
      { id: 'tenant-a', baseUrl: baseUrlA },
    ]);
    runtime.start();
    await new Promise((r) => setTimeout(r, 100)); // let the loop for tenant-a actually start polling
    store.setTargets([]); // tenant-a's descriptor disappears
    await new Promise((r) => setTimeout(r, 150)); // let reconcile() retire its loop
    const requestsAtRemoval = shimA.drainRequests.length;
    shimA.enqueue(message('too-late'));
    await new Promise((r) => setTimeout(r, 300));
    expect(shimA.drainRequests.length).toBe(requestsAtRemoval); // no further polls
    expect(sink.messages).toHaveLength(0);
    await runtime.stop();
    deliveryClient.close();
  });

  it('a message the sink accepts is acknowledged exactly once', async () => {
    shimA.enqueue(message('m1'));
    const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }]);
    runtime.start();
    await sink.waitForCount(1, 1000);
    await new Promise((r) => setTimeout(r, 200)); // let the ack round-trip complete
    await runtime.stop();
    deliveryClient.close();

    const ackedIds = shimA.ackRequests.flat().map((a) => a.id);
    expect(ackedIds).toEqual(['m1']);
    // The shim's own queue is empty -- acked, not merely delivered.
    const remaining = await createDrainClient({
      drainToken: DRAIN_TOKEN,
      drainTimeoutMs: 5000,
    }).drain({
      id: 'tenant-a',
      baseUrl: baseUrlA,
    });
    expect(remaining).toEqual([]);
  });

  it('LOST ACK: a message whose acknowledgement never lands reaches the sink once, not twice', async () => {
    shimA.enqueue(message('m1'));

    let ackAttempts = 0;
    const realDrainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    const lossyDrainClient: DrainClient = {
      drain: (target, signal) => realDrainClient.drain(target, signal),
      async ack(target, acks: DrainAck[], signal) {
        ackAttempts += 1;
        if (ackAttempts === 1) {
          // The ack never reaches the shim at all -- indistinguishable, from
          // this process's side, from a network drop in flight.
          throw new Error('simulated lost ack');
        }
        return realDrainClient.ack(target, acks, signal);
      },
    };

    const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }], {
      drainClient: lossyDrainClient,
    });
    runtime.start();

    // The first delivery happens; its ack is the one that gets lost.
    await sink.waitForCount(1, 1000);
    await new Promise((r) => setTimeout(r, 100));
    expect(ackAttempts).toBeGreaterThanOrEqual(1);

    // The shim never saw the ack, so from its side the row is still held --
    // simulate the lease lapsing, which re-offers the SAME id.
    shimA.simulateLostAck();

    // The second drain-and-ack pass succeeds this time.
    await new Promise((r) => setTimeout(r, 300));
    await runtime.stop();
    deliveryClient.close();

    expect(sink.messages).toHaveLength(1); // delivered exactly once despite the re-offer
    expect(sink.messages[0]!.envelopeTo).toEqual(['reader-m1@example.com']);

    const remaining = await realDrainClient.drain({ id: 'tenant-a', baseUrl: baseUrlA });
    expect(remaining).toEqual([]); // and eventually acked, clearing the shim's queue
  });

  it('a failed GET /drain is logged and retried, not fatal to the loop', async () => {
    let drainAttempts = 0;
    const realDrainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    const flakyDrainClient: DrainClient = {
      async drain(target, signal) {
        drainAttempts += 1;
        if (drainAttempts === 1) {
          throw new Error('simulated transient network failure');
        }
        return realDrainClient.drain(target, signal);
      },
      ack: (target, acks, signal) => realDrainClient.ack(target, acks, signal),
    };
    shimA.enqueue(message('m1'));
    const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }], {
      drainClient: flakyDrainClient,
    });
    runtime.start();
    const received = await sink.waitForCount(1, 2000);
    expect(received[0]!.envelopeTo).toEqual(['reader-m1@example.com']);
    expect(drainAttempts).toBeGreaterThanOrEqual(2);
    await runtime.stop();
    deliveryClient.close();
  });

  it('a delivery failure leaves the message unacked rather than losing or duplicating it', async () => {
    shimA.enqueue(message('m1'));
    const store = createFakeTargetStore([{ id: 'tenant-a', baseUrl: baseUrlA }]);
    const drainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    // Wrong credentials -- every delivery attempt fails, as if mx1 rejected the submission.
    const deliveryClient = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'not-the-real-secret',
    });
    const throttle = createThrottle({ messagesPerHour: 360_000 });
    const dedupe = createDeliveredTracker(60_000);
    const log = createLogger(() => {});
    const runtime = createCollectorRuntime({
      store,
      drainClient,
      deliveryClient,
      throttle,
      dedupe,
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 20,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    await new Promise((r) => setTimeout(r, 300));
    await runtime.stop();
    deliveryClient.close();

    expect(sink.messages).toHaveLength(0); // never delivered
    expect(dedupe.has('m1')).toBe(false); // never marked delivered
    expect(shimA.ackRequests.flat()).toHaveLength(0); // never acked either
  });

  it('a descriptor refresh failure is logged and does not stop the loop', async () => {
    shimA.enqueue(message('m1'));
    let refreshCalls = 0;
    const realStore = createFakeTargetStore([{ id: 'tenant-a', baseUrl: baseUrlA }]);
    const flakyStore = {
      get targets() {
        return realStore.targets;
      },
      isStale: false,
      async refresh(): Promise<void> {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          throw new Error('simulated descriptor directory outage');
        }
        return realStore.refresh();
      },
    };
    const drainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    const deliveryClient = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'sink-secret',
    });
    const throttle = createThrottle({ messagesPerHour: 360_000 });
    const dedupe = createDeliveredTracker(60_000);
    const log = createLogger(() => {});
    const runtime = createCollectorRuntime({
      store: flakyStore,
      drainClient,
      deliveryClient,
      throttle,
      dedupe,
      log,
      descriptorRefreshMs: 30,
      drainRetryBackoffMs: 20,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    const received = await sink.waitForCount(1, 2000);
    expect(received[0]!.envelopeTo).toEqual(['reader-m1@example.com']);
    expect(refreshCalls).toBeGreaterThanOrEqual(1);
    await runtime.stop();
    deliveryClient.close();
  });
});
