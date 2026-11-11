import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker, type SubmittedTracker } from '../../src/dedupe.js';
import type { DeliveryClient } from '../../src/deliveryClient.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient, type DrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import type { SweegoQuota } from '../../src/sendingTarget.js';
import { createFailureCounter } from '../../src/submissionFailures.js';
import { createSweegoDeliveryClient } from '../../src/sweegoDeliveryClient.js';
import { SweegoSubmissionError, type CountedFailureReason } from '../../src/sweegoFailure.js';
import { createThrottle, type Throttle } from '../../src/throttle.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import {
  closedLoopbackPort,
  startFakeSweegoRelay,
  type FakeRelay,
  type RelayBehaviour,
} from '../helpers/fakeSweegoRelay.js';
import {
  DRAIN_TOKEN,
  LOGIN,
  NEWSLETTER,
  QUOTA_FREE,
  countingThrottle,
  fakeClient,
  settle,
  until,
} from '../helpers/loopHarness.js';

const RELAY_USER = 'RELAY_USER_PLACEHOLDER';
const RELAY_PASS = 'relay-pass-7c1e9d-placeholder';

describe('collector loop with the Sweego client', () => {
  let shim: FakeShimServer;
  let baseUrl: string;
  let dir: string;
  let relay: FakeRelay;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    shim = new FakeShimServer(DRAIN_TOKEN);
    baseUrl = await shim.listen();
    dir = mkdtempSync(join(tmpdir(), 'collector-sweego-loop-'));
    writeFileSync(join(dir, 'relay-credential'), RELAY_PASS, { mode: 0o600 });
    relay = await startFakeSweegoRelay(RELAY_USER, RELAY_PASS);
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    await shim.close();
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The real Sweego client, pointed at the fake relay (or at a port nothing listens on). */
  function realSweego(options: { port?: number; timeoutMs?: number } = {}): DeliveryClient {
    return createSweegoDeliveryClient({
      host: '127.0.0.1',
      port: options.port ?? relay.port,
      secure: false,
      user: RELAY_USER,
      passFile: join(dir, 'relay-credential'),
      timeoutMs: options.timeoutMs ?? 5000,
      requireTls: false,
    });
  }

  function start(options: {
    mx1: DeliveryClient;
    sweego?: DeliveryClient;
    quota?: SweegoQuota;
    target?: Partial<DrainTarget>;
    throttle?: Throttle;
    sweegoThrottle?: Throttle | null;
    drainClient?: DrainClient;
    sweegoPins?: SubmittedTracker;
    mx1Pins?: SubmittedTracker;
    sweegoAmbiguous?: SubmittedTracker;
  }) {
    const store = createFakeTargetStore([
      { id: 'tenant-a', baseUrl, route: 'sweego', ...options.target },
    ]);
    const failures = createFailureCounter();
    const logLines: string[] = [];
    const mx1Throttle = options.throttle ?? countingThrottle();
    const sweegoThrottle =
      options.sweegoThrottle === null ? undefined : (options.sweegoThrottle ?? countingThrottle());
    const runtime = createCollectorRuntime({
      store,
      drainClient:
        options.drainClient ?? createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: options.mx1,
      sweegoDeliveryClient: options.sweego,
      sweegoThrottle,
      sweegoQuota: options.quota ?? QUOTA_FREE,
      sweegoFailures: failures,
      sweegoPins: options.sweegoPins,
      mx1Pins: options.mx1Pins,
      sweegoAmbiguous: options.sweegoAmbiguous,
      throttle: mx1Throttle,
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger((line) => logLines.push(line)),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    stop = () => runtime.stop();
    return { store, failures, logLines };
  }

  const acked = (): string[] => shim.ackRequests.flat().map((ack) => ack.id);

  it('submits a drained message to the relay, with the credential from its file, past the mx1 throttle', async () => {
    const mx1 = fakeClient();
    shim.enqueue(LOGIN('login-1'));
    shim.enqueue(NEWSLETTER('news-1'));
    const mx1Throttle = countingThrottle();
    const sweegoThrottle = countingThrottle();
    start({ mx1, sweego: realSweego(), throttle: mx1Throttle, sweegoThrottle });
    await until(() => acked().length === 2, 'both acked');
    expect(relay.accepted).toHaveLength(2);
    expect(relay.logins.every((l) => l.user === RELAY_USER && l.pass === RELAY_PASS)).toBe(true);
    expect(mx1.calls).toEqual([]);
    expect(mx1Throttle.taken).toBe(0);
    expect(sweegoThrottle.taken).toBe(2);
  });

  describe("Sweego's throttle is its own", () => {
    it('lets Sweego mail through while mx1 has no tokens left', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      // One mx1 token an hour, already spent: mx1 mail would wait out the hour.
      const mx1Throttle = createThrottle({ messagesPerHour: 1 });
      expect(mx1Throttle.tryTake()).toBe(true);
      expect(mx1Throttle.tryTake()).toBe(false);
      for (const id of ['news-1', 'news-2', 'news-3']) {
        shim.enqueue(NEWSLETTER(id));
      }
      start({
        mx1,
        sweego,
        throttle: mx1Throttle,
        sweegoThrottle: createThrottle({ messagesPerHour: 360_000 }),
      });
      await until(() => acked().length === 3, 'all three acked through sweego');
      expect(sweego.calls).toHaveLength(3);
      expect(mx1.calls).toEqual([]);
    });

    it('spends tokens from no other bucket: mx1 mail does not draw on it', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(NEWSLETTER('news-1'));
      const sweegoThrottle = countingThrottle();
      start({
        mx1,
        sweego,
        sweegoThrottle,
        target: { route: 'mx1' },
      });
      await until(() => acked().length === 1, 'acked through mx1');
      expect(sweegoThrottle.taken).toBe(0);
    });

    it('sends nothing to Sweego without a throttle of its own: the relay is read as not configured', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(NEWSLETTER('news-1'));
      start({ mx1, sweego, sweegoThrottle: null });
      await until(() => acked().length === 1, 'acked through mx1');
      expect(sweego.calls).toEqual([]);
      expect(mx1.calls).toEqual(['news-1']);
    });
  });

  describe('a lost ack after a Sweego accept', () => {
    it('is only re-acked on the next offer, never re-sent to the relay', async () => {
      const mx1 = fakeClient();
      shim.enqueue(LOGIN('login-1'));
      const real = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
      let lostOnce = false;
      const drainClient: DrainClient = {
        drain: real.drain,
        ack: async (target, acks, signal) => {
          if (!lostOnce) {
            lostOnce = true;
            throw new Error('ack lost');
          }
          return real.ack(target, acks, signal);
        },
      };
      start({ mx1, sweego: realSweego(), drainClient });
      await until(() => lostOnce, 'first ack lost');
      expect(relay.accepted).toHaveLength(1);
      shim.simulateLostAck();
      await until(() => acked().length >= 1, 'acked on the re-offer');
      await settle();
      expect(relay.accepted).toHaveLength(1);
      expect(relay.logins).toHaveLength(1);
      expect(mx1.calls).toEqual([]);
    });
  });

  describe('failures that let login mail fall back to mx1', () => {
    // The relay refusing at each step the design names as a definite
    // non-acceptance. If the client did not throw the classified error, none
    // of these would reach mx1.
    const NOT_ACCEPTED: Array<[string, RelayBehaviour, CountedFailureReason]> = [
      ['login refused', { authReply: 535 }, 'auth'],
      ['a 4xx at MAIL', { mailFromReply: 451 }, 'deferred'],
      ['a 4xx at RCPT', { rcptReply: 450 }, 'deferred'],
      ['a 5xx at MAIL', { mailFromReply: 550 }, 'refused'],
      ['a 4xx at the DATA command', { dataCommandReply: 451 }, 'deferred'],
      ['a 5xx at the DATA command', { dataCommandReply: 554 }, 'refused'],
    ];

    it.each(NOT_ACCEPTED)(
      'falls login mail back to mx1 once on %s, and counts the reason',
      async (_label, behaviour, reason) => {
        relay.behaviour = behaviour;
        const mx1 = fakeClient();
        shim.enqueue(LOGIN('login-1'));
        const { failures } = start({ mx1, sweego: realSweego() });
        await until(() => acked().length === 1, 'login acked');
        expect(mx1.calls).toEqual(['login-1']);
        expect(relay.accepted).toEqual([]);
        expect(failures.counts()).toEqual({ [reason]: 1 });
      }
    );

    it('falls login mail back to mx1 when the relay cannot be reached', async () => {
      const mx1 = fakeClient();
      shim.enqueue(LOGIN('login-1'));
      const { failures } = start({
        mx1,
        sweego: realSweego({ port: await closedLoopbackPort() }),
      });
      await until(() => acked().length === 1, 'login acked');
      expect(mx1.calls).toEqual(['login-1']);
      expect(failures.counts()).toEqual({ unreachable: 1 });
    });

    it('leaves bulk unacked on the same failures and never tries mx1', async () => {
      relay.behaviour = { rcptReply: 450 };
      const mx1 = fakeClient();
      shim.enqueue(NEWSLETTER('news-1'));
      const { failures } = start({ mx1, sweego: realSweego() });
      await until(() => (failures.counts().deferred ?? 0) >= 1, 'first failure counted');
      await settle();
      expect(mx1.calls).toEqual([]);
      expect(acked()).toEqual([]);
    });

    it.each([
      ['a 4xx at the end of DATA', { dataReply: 451 }, 'ambiguous'],
      ['a 5xx at the end of DATA', { dataReply: 554 }, 'ambiguous'],
      ['a timeout after DATA', { hangAfterData: true }, 'timeout'],
    ] satisfies Array<[string, RelayBehaviour, CountedFailureReason]>)(
      'keeps login mail off mx1 after %s: the relay may have it',
      async (_label, behaviour, reason) => {
        relay.behaviour = behaviour;
        const mx1 = fakeClient();
        shim.enqueue(LOGIN('login-1'));
        const { failures } = start({ mx1, sweego: realSweego({ timeoutMs: 400 }) });
        await until(() => (failures.counts()[reason] ?? 0) >= 1, 'failure counted');
        await settle();
        expect(mx1.calls).toEqual([]);
        expect(acked()).toEqual([]);
      }
    );
  });

  describe('a recipient the relay refuses for good', () => {
    it.each([
      ['login', LOGIN],
      ['bulk', NEWSLETTER],
    ])(
      'drops %s mail with a counted reason: acked, never retried, never sent to mx1',
      async (_label, build) => {
        relay.behaviour = { rcptReply: 550 };
        const mx1 = fakeClient();
        shim.enqueue(build('bad-1'));
        const { failures } = start({ mx1, sweego: realSweego() });
        await until(() => acked().includes('bad-1'), 'dropped message acked');
        await settle();
        expect(failures.counts()).toEqual({ 'recipient-rejected': 1 });
        expect(relay.logins).toHaveLength(1);
        expect(relay.accepted).toEqual([]);
        expect(mx1.calls).toEqual([]);
      }
    );

    it('is not offered to the relay again when the ack for the drop is lost', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError('recipient-rejected', 550);
      shim.enqueue(NEWSLETTER('bad-1'));
      const real = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
      let lostOnce = false;
      const drainClient: DrainClient = {
        drain: real.drain,
        ack: async (target, acks, signal) => {
          if (!lostOnce) {
            lostOnce = true;
            throw new Error('ack lost');
          }
          return real.ack(target, acks, signal);
        },
      };
      start({ mx1, sweego, drainClient });
      await until(() => lostOnce, 'first ack lost');
      shim.simulateLostAck();
      await until(() => acked().length >= 1, 'acked on the re-offer');
      expect(sweego.calls).toEqual(['bad-1']);
    });
  });

  describe('each message stays on the target it first went to', () => {
    // Sweego may have taken the message (the attempt timed out), then the
    // tenant's allowance runs out or its route changes: a retry through mx1
    // would send it twice.
    it.each([
      ['login', LOGIN],
      ['bulk', NEWSLETTER],
    ])(
      'keeps a %s retry on Sweego when the allowance is reached after an ambiguous failure',
      async (_label, build) => {
        const mx1 = fakeClient();
        const sweego = fakeClient();
        sweego.behaviour = () => new SweegoSubmissionError('timeout');
        let reached = false;
        const quota: SweegoQuota = {
          allowanceReached: () => reached,
          accountCapReached: () => false,
        };
        shim.enqueue(build('m-1'));
        start({ mx1, sweego, quota });
        await until(() => sweego.calls.length >= 1, 'first attempt');
        reached = true;
        sweego.behaviour = () => undefined;
        shim.simulateLostAck();
        await until(() => acked().length === 1, 'acked');
        expect(sweego.calls).toEqual(['m-1', 'm-1']);
        expect(mx1.calls).toEqual([]);
      }
    );

    it('keeps a retry on Sweego when the tenant route is switched to mx1 in between', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError('timeout');
      shim.enqueue(NEWSLETTER('m-1'));
      const { store } = start({ mx1, sweego });
      await until(() => sweego.calls.length >= 1, 'first attempt');
      store.setTargets([{ id: 'tenant-a', baseUrl, route: 'mx1' }]);
      sweego.behaviour = () => undefined;
      shim.simulateLostAck();
      await until(() => acked().length === 1, 'acked');
      expect(sweego.calls).toEqual(['m-1', 'm-1']);
      expect(mx1.calls).toEqual([]);
    });

    it('holds a pinned message, rather than sending it to mx1, after a restart without a relay', async () => {
      const pinFile = join(dir, 'sweego-pins.json');
      const pinned = (): SubmittedTracker =>
        createSubmittedTracker(60_000, Date.now, { statePath: pinFile });
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError('timeout');
      shim.enqueue(LOGIN('m-1'));
      start({ mx1: fakeClient(), sweego, sweegoPins: pinned() });
      await until(() => sweego.calls.length >= 1, 'first attempt');
      await stop?.();
      stop = undefined;

      const mx1 = fakeClient();
      shim.simulateLostAck();
      const second = start({ mx1, sweegoPins: pinned() });
      await until(
        () => second.logLines.some((line) => line.includes('sweego_pinned_unavailable')),
        'pinned message held'
      );
      await settle();
      expect(mx1.calls).toEqual([]);
      expect(acked()).toEqual([]);
    });

    it('lets login mail that fell back to mx1 stay on mx1 although it was first tried at Sweego', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError('unreachable');
      mx1.behaviour = () => new Error('mx1 down');
      shim.enqueue(LOGIN('m-1'));
      start({ mx1, sweego });
      await until(() => mx1.calls.length >= 1, 'fell back to mx1');
      sweego.behaviour = () => undefined;
      mx1.behaviour = () => undefined;
      shim.simulateLostAck();
      await until(() => acked().length === 1, 'acked');
      expect(sweego.calls).toEqual(['m-1']);
      expect(mx1.calls).toEqual(['m-1', 'm-1']);
    });
  });

  describe('only a bad address is dropped', () => {
    it.each([
      ['a 4xx', { dataCommandReply: 451 }, 'deferred'],
      ['a 5xx', { dataCommandReply: 554 }, 'refused'],
    ] satisfies Array<[string, RelayBehaviour, CountedFailureReason]>)(
      'holds bulk mail the relay refuses with %s at the DATA command, and sends it once the relay recovers',
      async (_label, behaviour, reason) => {
        relay.behaviour = behaviour;
        const mx1 = fakeClient();
        shim.enqueue(NEWSLETTER('news-1'));
        const { failures } = start({ mx1, sweego: realSweego() });
        await until(() => (failures.counts()[reason] ?? 0) >= 1, 'refusal counted');
        await settle();
        expect(acked()).toEqual([]);
        expect(mx1.calls).toEqual([]);
        expect(failures.counts()['recipient-rejected']).toBeUndefined();

        relay.behaviour = {};
        shim.simulateLostAck();
        await until(() => acked().length === 1, 'acked after recovery');
        expect(relay.accepted).toHaveLength(1);
      }
    );

    it('never drops login mail on a temporary refusal: it falls back to mx1 and is delivered', async () => {
      relay.behaviour = { dataCommandReply: 451 };
      const mx1 = fakeClient();
      shim.enqueue(LOGIN('login-1'));
      const { failures } = start({ mx1, sweego: realSweego() });
      await until(() => acked().length === 1, 'login acked');
      expect(mx1.calls).toEqual(['login-1']);
      expect(failures.counts()).toEqual({ deferred: 1 });
    });
  });

  describe('a message that may already have been taken', () => {
    it('does not fall login mail back to mx1 on a later definite failure after an ambiguous one', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError('timeout');
      shim.enqueue(LOGIN('login-1'));
      start({ mx1, sweego });
      await until(() => sweego.calls.length >= 1, 'first attempt');
      sweego.behaviour = () => new SweegoSubmissionError('auth', 535);
      shim.simulateLostAck();
      await until(() => sweego.calls.length >= 2, 'second attempt');
      await settle();
      expect(mx1.calls).toEqual([]);
      expect(acked()).toEqual([]);
    });

    it('still drops a bad address after an ambiguous attempt: it is bad wherever it is sent', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError('timeout');
      shim.enqueue(LOGIN('login-1'));
      start({ mx1, sweego });
      await until(() => sweego.calls.length >= 1, 'first attempt');
      sweego.behaviour = () => new SweegoSubmissionError('recipient-rejected', 550);
      shim.simulateLostAck();
      await until(() => acked().length === 1, 'dropped and acked');
      expect(mx1.calls).toEqual([]);
    });

    it('remembers the ambiguity across a restart', async () => {
      const file = join(dir, 'sweego-ambiguous.json');
      const tracker = (): SubmittedTracker =>
        createSubmittedTracker(60_000, Date.now, { statePath: file });
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError('timeout');
      shim.enqueue(LOGIN('login-1'));
      start({ mx1: fakeClient(), sweego, sweegoAmbiguous: tracker() });
      await until(() => sweego.calls.length >= 1, 'first attempt');
      await stop?.();
      stop = undefined;

      const mx1 = fakeClient();
      const again = fakeClient();
      again.behaviour = () => new SweegoSubmissionError('auth', 535);
      shim.simulateLostAck();
      start({ mx1, sweego: again, sweegoAmbiguous: tracker() });
      await until(() => again.calls.length >= 1, 'attempt after restart');
      await settle();
      expect(mx1.calls).toEqual([]);
    });
  });

  describe('a pin file that has vanished', () => {
    it('holds a re-offered message, as for a corrupt file, rather than letting it reach mx1 or a second Sweego attempt', async () => {
      const files = ['mx1-pins.json', 'sweego-pins.json', 'sweego-ambiguous.json'].map((name) =>
        join(dir, name)
      );
      const trackers = (): SubmittedTracker[] =>
        files.map((statePath) => createSubmittedTracker(60_000, Date.now, { statePath }));
      const [mx1Pins, sweegoPins, sweegoAmbiguous] = trackers() as [
        SubmittedTracker,
        SubmittedTracker,
        SubmittedTracker,
      ];
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError('timeout');
      shim.enqueue(LOGIN('login-1'));
      start({ mx1: fakeClient(), sweego, mx1Pins, sweegoPins, sweegoAmbiguous });
      await until(() => sweego.calls.length >= 1, 'first attempt');
      await stop?.();
      stop = undefined;

      // An unmounted or wiped volume takes the files with it; the markers beside them stay.
      for (const file of files) {
        rmSync(file, { force: true });
      }
      const [mx1PinsAfter, sweegoPinsAfter, sweegoAmbiguousAfter] = trackers() as [
        SubmittedTracker,
        SubmittedTracker,
        SubmittedTracker,
      ];
      const mx1 = fakeClient();
      const recovered = fakeClient();
      shim.simulateLostAck();
      const second = start({
        mx1,
        sweego: recovered,
        quota: { allowanceReached: () => true, accountCapReached: () => false },
        mx1Pins: mx1PinsAfter,
        sweegoPins: sweegoPinsAfter,
        sweegoAmbiguous: sweegoAmbiguousAfter,
      });
      await until(
        () => second.logLines.some((line) => line.includes('pin_state_lost_held')),
        'message held'
      );
      await settle();
      expect(mx1.calls).toEqual([]);
      expect(recovered.calls).toEqual([]);
      expect(acked()).toEqual([]);
    });
  });

  describe('a pin file that cannot be read', () => {
    it('holds a re-offered message rather than letting it reach mx1 or a second Sweego attempt', async () => {
      const files = ['mx1-pins.json', 'sweego-pins.json', 'sweego-ambiguous.json'].map((name) =>
        join(dir, name)
      );
      const trackers = (): SubmittedTracker[] =>
        files.map((statePath) => createSubmittedTracker(60_000, Date.now, { statePath }));
      const [mx1Pins, sweegoPins, sweegoAmbiguous] = trackers() as [
        SubmittedTracker,
        SubmittedTracker,
        SubmittedTracker,
      ];
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError('timeout');
      shim.enqueue(LOGIN('login-1'));
      start({ mx1: fakeClient(), sweego, mx1Pins, sweegoPins, sweegoAmbiguous });
      await until(() => sweego.calls.length >= 1, 'first attempt');
      await stop?.();
      stop = undefined;

      for (const file of files) {
        writeFileSync(file, '{ this is not json');
      }
      const [mx1PinsAfter, sweegoPinsAfter, sweegoAmbiguousAfter] = trackers() as [
        SubmittedTracker,
        SubmittedTracker,
        SubmittedTracker,
      ];
      // The allowance is now reached, so a message without its pin goes to mx1.
      const mx1 = fakeClient();
      const recovered = fakeClient();
      shim.simulateLostAck();
      const second = start({
        mx1,
        sweego: recovered,
        quota: { allowanceReached: () => true, accountCapReached: () => false },
        mx1Pins: mx1PinsAfter,
        sweegoPins: sweegoPinsAfter,
        sweegoAmbiguous: sweegoAmbiguousAfter,
      });
      await until(
        () => second.logLines.some((line) => line.includes('pin_state_lost_held')),
        'message held'
      );
      await settle();
      expect(mx1.calls).toEqual([]);
      expect(recovered.calls).toEqual([]);
      expect(acked()).toEqual([]);
    });
  });
});
