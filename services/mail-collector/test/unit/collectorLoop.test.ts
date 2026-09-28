import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDrainClient, type DrainAck, type DrainClient } from '../../src/drainClient.js';
import { createDeliveryClient } from '../../src/deliveryClient.js';
import { createHealthState } from '../../src/health.js';
import { createDeadMansSwitch, type DeadMansSwitch } from '../../src/heartbeat.js';
import { createThrottle, type Throttle } from '../../src/throttle.js';
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

  function buildRuntime(
    targets: DrainTarget[],
    overrides: { drainClient?: DrainClient; throttle?: Throttle; heartbeat?: DeadMansSwitch } = {}
  ) {
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
    // Generous by default -- not the throttle test's job, except in the
    // tests below that override it specifically to prove the throttle
    // itself.
    const throttle = overrides.throttle ?? createThrottle({ messagesPerHour: 360_000 });
    const dedupe = createSubmittedTracker(60_000);
    const health = createHealthState();
    const log = createLogger(() => {});
    const runtime = createCollectorRuntime({
      store,
      drainClient,
      deliveryClient,
      throttle,
      dedupe,
      health,
      heartbeat: overrides.heartbeat,
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    return { runtime, store, deliveryClient, dedupe, health, throttle };
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
    // The shim's own queue is empty -- acked, not merely submitted.
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

    expect(sink.messages).toHaveLength(1); // submitted exactly once despite the re-offer
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
    const dedupe = createSubmittedTracker(60_000);
    const health = createHealthState();
    const log = createLogger(() => {});
    const runtime = createCollectorRuntime({
      store,
      drainClient,
      deliveryClient,
      throttle,
      dedupe,
      health,
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 20,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    await new Promise((r) => setTimeout(r, 300));
    await runtime.stop();
    deliveryClient.close();

    expect(sink.messages).toHaveLength(0); // never submitted
    expect(dedupe.has('m1')).toBe(false); // never marked submitted
    expect(shimA.ackRequests.flat()).toHaveLength(0); // never acked either
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(1); // the health signal noticed
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
    const dedupe = createSubmittedTracker(60_000);
    const health = createHealthState();
    const log = createLogger(() => {});
    const runtime = createCollectorRuntime({
      store: flakyStore,
      drainClient,
      deliveryClient,
      throttle,
      dedupe,
      health,
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

  describe('the estate-wide throttle, proven at the seam it actually changed', () => {
    let throttleDir: string;

    beforeEach(() => {
      throttleDir = mkdtempSync(join(tmpdir(), 'collector-throttle-wiring-'));
    });

    afterEach(() => {
      rmSync(throttleDir, { recursive: true, force: true });
    });

    it('a message queued shortly AFTER an edit, on an otherwise-idle collector, sees the new rate -- proactive reload, not only reload-while-waiting', async () => {
      // Isolates the idle-collector reload path (no in-flight message ever
      // calls waitForToken(), so only collectorLoop.ts's own per-iteration
      // reload can pick up the edit) from the already-covered
      // reload-while-waiting path.
      // See ../../README.md#collectorloop-test-proactive-throttle-reload.
      const configPath = join(throttleDir, 'throttle.json');
      writeFileSync(configPath, JSON.stringify({ messagesPerHour: 5 }));
      const throttle = createThrottle({ configPath, messagesPerHour: 5 });

      const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }], {
        throttle,
      });
      runtime.start();
      await new Promise((r) => setTimeout(r, 150)); // several empty-poll iterations with nothing queued

      writeFileSync(configPath, JSON.stringify({ messagesPerHour: 999 }));
      await new Promise((r) => setTimeout(r, 150)); // more idle iterations -- the ONLY way this rate can already be loaded

      expect(throttle.currentRate()).toBe(999);

      await runtime.stop();
      deliveryClient.close();
    });

    it('SHARED BUCKET: two hosts drained concurrently draw from ONE estate-wide ceiling, not one bucket each', async () => {
      const throttle = createThrottle({ messagesPerHour: 3600 }); // 1 token/second of real wall-clock time
      shimA.enqueue(message('from-a'));
      shimB.enqueue(message('from-b'));
      const { runtime, deliveryClient } = buildRuntime(
        [
          { id: 'tenant-a', baseUrl: baseUrlA },
          { id: 'tenant-b', baseUrl: baseUrlB },
        ],
        { throttle }
      );
      runtime.start();

      const received = await sink.waitForCount(2, 3000);
      const [first, second] = [...received].sort((a, b) => a.receivedAt - b.receivedAt);
      // One shared bucket starting with exactly one grace token means the
      // FIRST message (whichever host it came from) goes out immediately,
      // and the SECOND -- regardless of which host it is on -- has to wait
      // for the bucket to refill at 1/second. A comfortable margin under
      // the full second accounts for scheduler jitter without weakening
      // the property: two independent per-host buckets (the sabotage
      // below) would both have their own grace token and this gap would
      // read close to zero.
      expect(second!.receivedAt - first!.receivedAt).toBeGreaterThanOrEqual(700);

      await runtime.stop();
      deliveryClient.close();
    });
  });

  describe('the heartbeat reflects real submission health through the running loop', () => {
    it('a collector failing every real submission becomes unhealthy through health.recordFailure(), wired to an actual delivery failure', async () => {
      shimA.enqueue(message('m1'));
      const store = createFakeTargetStore([{ id: 'tenant-a', baseUrl: baseUrlA }]);
      const drainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
      // Wrong credentials -- every submission mx1 (the sink) is offered fails, as if the estate's real credential were rejected.
      const deliveryClient = createDeliveryClient({
        host: '127.0.0.1',
        port: sink.port,
        secure: false,
        user: 'collector',
        pass: 'not-the-real-secret',
      });
      const throttle = createThrottle({ messagesPerHour: 360_000 });
      const dedupe = createSubmittedTracker(60_000);
      const health = createHealthState();
      const log = createLogger(() => {});
      const runtime = createCollectorRuntime({
        store,
        drainClient,
        deliveryClient,
        throttle,
        dedupe,
        health,
        log,
        descriptorRefreshMs: 50,
        drainRetryBackoffMs: 20,
        emptyPollBackoffMs: 20,
      });

      runtime.start();
      // m1 is claimed ('held') on the first drain and its delivery fails,
      // leaving it held and unacked -- exactly the real shim's behaviour
      // (routes/drain.ts). Nothing re-offers a held row until its lease
      // lapses; simulateLostAck() stands in for that lapse so the SAME
      // message keeps failing to submit across several real drain/deliver
      // cycles, the way a genuinely wedged credential would in production.
      await vi.waitFor(() => expect(health.consecutiveFailures).toBeGreaterThanOrEqual(1));
      shimA.simulateLostAck();
      await vi.waitFor(() => expect(health.consecutiveFailures).toBeGreaterThanOrEqual(2));
      shimA.simulateLostAck();
      await vi.waitFor(() => expect(health.consecutiveFailures).toBeGreaterThanOrEqual(3));
      expect(health.isHealthy(3)).toBe(false); // this is what a wired heartbeat's shouldPing() would read

      await runtime.stop();
      deliveryClient.close();
    });
  });

  describe("the dead man's switch pings once per completed poll cycle, through the real loop", () => {
    it('an idle host -- reachable, described, nothing queued -- still pings on every empty cycle', async () => {
      const pings = vi.fn();
      const heartbeat: DeadMansSwitch = { onCycleComplete: pings };
      const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }], {
        heartbeat,
      });
      runtime.start();
      // emptyPollBackoffMs is 20ms in buildRuntime -- several idle cycles
      // comfortably complete inside this window with nothing ever enqueued.
      await vi.waitFor(() => expect(pings.mock.calls.length).toBeGreaterThanOrEqual(3));
      await runtime.stop();
      deliveryClient.close();
    });

    it('a cycle that actually drains and delivers something still pings, same as an empty one', async () => {
      shimA.enqueue(message('m1'));
      const pings = vi.fn();
      const heartbeat: DeadMansSwitch = { onCycleComplete: pings };
      const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }], {
        heartbeat,
      });
      runtime.start();
      await sink.waitForCount(1, 1000);
      await vi.waitFor(() => expect(pings.mock.calls.length).toBeGreaterThanOrEqual(1));
      await runtime.stop();
      deliveryClient.close();
    });

    it('a drain failure against one host never reports a completed cycle for it -- the failing iteration is not counted', async () => {
      // Per-host gating: a host that cannot complete a cycle must not
      // report success, so collectorLoop.ts's drain-failure branch calls
      // heartbeat.onCycleComplete() for NEITHER this host nor the switch
      // as a whole -- the loop keeps retrying (it is not stuck), it just
      // never counts as a success while the failure persists.
      const failingDrainClient: DrainClient = {
        drain: () => Promise.reject(new Error('simulated: host unreachable')),
        ack: () => Promise.resolve({ acked: [], alreadyHandled: [], unknown: [] }),
      };
      const pings = vi.fn();
      const heartbeat: DeadMansSwitch = { onCycleComplete: pings };
      const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }], {
        drainClient: failingDrainClient,
        heartbeat,
      });
      runtime.start();
      await new Promise((r) => setTimeout(r, 200)); // several failed-drain retries elapse
      expect(pings).not.toHaveBeenCalled();
      await runtime.stop();
      deliveryClient.close();
    });

    it('with no heartbeat supplied, the loop runs exactly as before -- the dependency is optional, not required', async () => {
      shimA.enqueue(message('m1'));
      const { runtime, deliveryClient } = buildRuntime([{ id: 'tenant-a', baseUrl: baseUrlA }]);
      runtime.start();
      const received = await sink.waitForCount(1, 1000);
      expect(received[0]!.envelopeTo).toEqual(['reader-m1@example.com']);
      await runtime.stop();
      deliveryClient.close();
    });

    it('SABOTAGE -- gating the ping on "something was drained" starves the idle case: RED, then the real wiring: GREEN', async () => {
      // This reproduces the issue's own named sabotage: a heartbeat wired
      // to fire only when a cycle actually drained a message, rather than
      // on every completed cycle. Against a genuinely idle host this is
      // indistinguishable from a wedged loop -- the switch would go
      // Late then Down for a worker that is doing exactly what it should.
      const store = createFakeTargetStore([{ id: 'tenant-a', baseUrl: baseUrlA }]);
      const drainClient = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
      const deliveryClient = createDeliveryClient({
        host: '127.0.0.1',
        port: sink.port,
        secure: false,
        user: 'collector',
        pass: 'sink-secret',
      });
      const throttle = createThrottle({ messagesPerHour: 360_000 });
      const dedupe = createSubmittedTracker(60_000);
      const health = createHealthState();
      const log = createLogger(() => {});

      const pings = vi.fn();
      // The sabotaged wiring: nothing enqueued on shimA at any point in
      // this test, so a correct implementation calling onCycleComplete()
      // on every empty cycle pings repeatedly; the sabotage below only
      // calls it from inside a branch this test never reaches.
      const sabotagedHeartbeat: DeadMansSwitch = {
        onCycleComplete: () => {
          // Naive bug: this only runs when SOMETHING was drained. This
          // test's loop only ever sees empty drains, so this line never
          // fires at all -- the RED half of the sabotage.
          if (false as boolean) {
            pings();
          }
        },
      };

      const redRuntime = createCollectorRuntime({
        store,
        drainClient,
        deliveryClient,
        throttle,
        dedupe,
        health,
        heartbeat: sabotagedHeartbeat,
        log,
        descriptorRefreshMs: 50,
        drainRetryBackoffMs: 50,
        emptyPollBackoffMs: 20,
      });
      redRuntime.start();
      await new Promise((r) => setTimeout(r, 150)); // several empty cycles complete
      expect(pings).not.toHaveBeenCalled(); // RED: the idle worker never pinged
      await redRuntime.stop();

      // The real wiring, same idle scenario: onCycleComplete() fires on
      // every completed cycle regardless of what it drained.
      const realHeartbeat = createDeadMansSwitch({
        url: 'https://heartbeat.example/ping',
        log,
        getExpectedTargetIds: () => store.targets.map((t) => t.id),
        fetchImpl: (async () => {
          pings();
          return { ok: true, status: 200 } as Response;
        }) as typeof fetch,
      });
      const greenRuntime = createCollectorRuntime({
        store,
        drainClient,
        deliveryClient,
        throttle,
        dedupe,
        health,
        heartbeat: realHeartbeat,
        log,
        descriptorRefreshMs: 50,
        drainRetryBackoffMs: 50,
        emptyPollBackoffMs: 20,
      });
      greenRuntime.start();
      await vi.waitFor(() => expect(pings.mock.calls.length).toBeGreaterThanOrEqual(3)); // GREEN
      await greenRuntime.stop();
      deliveryClient.close();
    });
  });

  describe(
    'PER-HOST GATING: the switch pings only once EVERY described host has ' +
      'completed a cycle since the last ping',
    () => {
      function buildTwoHostRuntime(drainClient: DrainClient, fetchImpl: typeof fetch) {
        const store = createFakeTargetStore([
          { id: 'tenant-a', baseUrl: baseUrlA },
          { id: 'tenant-b', baseUrl: baseUrlB },
        ]);
        const deliveryClient = createDeliveryClient({
          host: '127.0.0.1',
          port: sink.port,
          secure: false,
          user: 'collector',
          pass: 'sink-secret',
        });
        const throttle = createThrottle({ messagesPerHour: 360_000 });
        const dedupe = createSubmittedTracker(60_000);
        const health = createHealthState();
        const log = createLogger(() => {});
        const heartbeat = createDeadMansSwitch({
          url: 'https://heartbeat.example/ping',
          log,
          fetchImpl,
          getExpectedTargetIds: () => store.targets.map((t) => t.id),
        });
        const runtime = createCollectorRuntime({
          store,
          drainClient,
          deliveryClient,
          throttle,
          dedupe,
          health,
          heartbeat,
          log,
          descriptorRefreshMs: 50,
          drainRetryBackoffMs: 30,
          emptyPollBackoffMs: 20,
        });
        return { runtime, deliveryClient };
      }

      it('ALL HOSTS EMPTY: two idle described hosts still ping -- zero mail across the estate is not a failure', async () => {
        const realDrainClient = createDrainClient({
          drainToken: DRAIN_TOKEN,
          drainTimeoutMs: 5000,
        });
        const pings = vi.fn();
        const fetchImpl = (async () => {
          pings();
          return { ok: true, status: 200 } as Response;
        }) as typeof fetch;
        const { runtime, deliveryClient } = buildTwoHostRuntime(realDrainClient, fetchImpl);
        runtime.start();
        await vi.waitFor(() => expect(pings.mock.calls.length).toBeGreaterThanOrEqual(1));
        await runtime.stop();
        deliveryClient.close();
      });

      it('ONE HOST PERMANENTLY FAILING: tenant-a keeps completing cycles, tenant-b never drains successfully -- no ping ever', async () => {
        const realDrainClient = createDrainClient({
          drainToken: DRAIN_TOKEN,
          drainTimeoutMs: 5000,
        });
        const perTargetDrainClient: DrainClient = {
          drain: (target, signal) => {
            if (target.id === 'tenant-b') {
              return Promise.reject(new Error('simulated: tenant-b permanently unreachable'));
            }
            return realDrainClient.drain(target, signal);
          },
          ack: (target, acks, signal) => realDrainClient.ack(target, acks, signal),
        };
        const pings = vi.fn();
        const fetchImpl = (async () => {
          pings();
          return { ok: true, status: 200 } as Response;
        }) as typeof fetch;
        const { runtime, deliveryClient } = buildTwoHostRuntime(perTargetDrainClient, fetchImpl);
        runtime.start();
        // Give tenant-a several successful empty cycles and tenant-b
        // several failed retries -- if the SABOTAGE (any target completing
        // pings, rather than every target) were still in place, tenant-a
        // alone would already have pinged repeatedly by now.
        await new Promise((r) => setTimeout(r, 250));
        expect(pings).not.toHaveBeenCalled();
        await runtime.stop();
        deliveryClient.close();
      });

      it("ONE HOST WEDGED: tenant-b's drain never resolves at all -- no ping while it is stuck", async () => {
        const realDrainClient = createDrainClient({
          drainToken: DRAIN_TOKEN,
          drainTimeoutMs: 5000,
        });
        // A genuinely wedged host's own drain() call never settles -- and,
        // by construction, nothing can ever cancel it either (production
        // collectorLoop.ts passes no AbortSignal into drain()). unwedge()
        // exists only so this test can let the pending await resolve
        // AFTER the assertion, so runtime.stop() -- which waits for every
        // target loop to notice `stopped` and exit -- does not hang the
        // test suite forever the way a real wedge legitimately would.
        let unwedge: (() => void) | undefined;
        const wedgedDrain = new Promise<never[]>((resolve) => {
          unwedge = () => resolve([]);
        });
        const perTargetDrainClient: DrainClient = {
          drain: (target, signal) => {
            if (target.id === 'tenant-b') {
              return wedgedDrain;
            }
            return realDrainClient.drain(target, signal);
          },
          ack: (target, acks, signal) => realDrainClient.ack(target, acks, signal),
        };
        const pings = vi.fn();
        const fetchImpl = (async () => {
          pings();
          return { ok: true, status: 200 } as Response;
        }) as typeof fetch;
        const { runtime, deliveryClient } = buildTwoHostRuntime(perTargetDrainClient, fetchImpl);
        runtime.start();
        await new Promise((r) => setTimeout(r, 250)); // tenant-a completes several cycles; tenant-b's loop is stuck on its first
        expect(pings).not.toHaveBeenCalled();
        unwedge?.();
        await new Promise((r) => setTimeout(r, 50)); // let tenant-b's now-unstuck iteration reach its next stop-check
        await runtime.stop();
        deliveryClient.close();
      });

      it('RECOVERY: once the failing host starts completing cycles again, pinging resumes', async () => {
        const realDrainClient = createDrainClient({
          drainToken: DRAIN_TOKEN,
          drainTimeoutMs: 5000,
        });
        let tenantBFailing = true;
        const perTargetDrainClient: DrainClient = {
          drain: (target, signal) => {
            if (target.id === 'tenant-b' && tenantBFailing) {
              return Promise.reject(new Error('simulated: tenant-b unreachable for now'));
            }
            return realDrainClient.drain(target, signal);
          },
          ack: (target, acks, signal) => realDrainClient.ack(target, acks, signal),
        };
        const pings = vi.fn();
        const fetchImpl = (async () => {
          pings();
          return { ok: true, status: 200 } as Response;
        }) as typeof fetch;
        const { runtime, deliveryClient } = buildTwoHostRuntime(perTargetDrainClient, fetchImpl);
        runtime.start();
        await new Promise((r) => setTimeout(r, 200));
        expect(pings).not.toHaveBeenCalled(); // silenced while tenant-b fails

        tenantBFailing = false; // tenant-b recovers
        await vi.waitFor(() => expect(pings.mock.calls.length).toBeGreaterThanOrEqual(1));
        await runtime.stop();
        deliveryClient.close();
      });
    }
  );
});
