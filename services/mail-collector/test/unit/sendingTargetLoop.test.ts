import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { TargetSubmissionError, type SweegoQuota } from '../../src/sendingTarget.js';
import type { Throttle } from '../../src/throttle.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import {
  DRAIN_TOKEN,
  LOGIN,
  NEWSLETTER,
  QUOTA_FREE,
  countingThrottle,
  fakeClient,
  settle,
  until,
  type FakeClient,
} from '../helpers/loopHarness.js';

describe('collector loop with two sending targets', () => {
  let shim: FakeShimServer;
  let baseUrl: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    shim = new FakeShimServer(DRAIN_TOKEN);
    baseUrl = await shim.listen();
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    await shim.close();
  });

  function start(options: {
    target?: Partial<DrainTarget>;
    mx1: FakeClient;
    sweego?: FakeClient;
    quota?: SweegoQuota;
    throttle?: Throttle;
  }) {
    const store = createFakeTargetStore([
      { id: 'tenant-a', baseUrl, route: 'sweego', ...options.target },
    ]);
    const health = createHealthState();
    const tokens = { taken: 0 };
    const throttle: Throttle = options.throttle ?? {
      tryTake: () => true,
      waitForToken: async () => {
        tokens.taken += 1;
      },
      reload() {},
      currentRate: () => 0,
    };
    const sweegoThrottle = countingThrottle();
    const runtime = createCollectorRuntime({
      store,
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: options.mx1,
      sweegoDeliveryClient: options.sweego,
      sweegoThrottle,
      sweegoQuota: options.quota,
      throttle,
      dedupe: createSubmittedTracker(60_000),
      health,
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    stop = () => runtime.stop();
    return { store, health, tokens, sweegoThrottle };
  }

  const acked = (): string[] => shim.ackRequests.flat().map((ack) => ack.id);

  it('sends both classes to sweego for a sweego route, past the estate throttle, never touching mx1', async () => {
    const mx1 = fakeClient();
    const sweego = fakeClient();
    shim.enqueue(LOGIN('login-1'));
    shim.enqueue(NEWSLETTER('news-1'));
    const { tokens, sweegoThrottle } = start({ mx1, sweego, quota: QUOTA_FREE });
    await until(() => acked().length === 2, 'both acked');
    expect(sweego.calls.sort()).toEqual(['login-1', 'news-1']);
    expect(mx1.calls).toEqual([]);
    expect(tokens.taken).toBe(0);
    expect(sweegoThrottle.taken).toBe(2);
  });

  it('serves a sweego route by mx1 when no sweego client exists, both classes, at the estate throttle', async () => {
    const mx1 = fakeClient();
    shim.enqueue(LOGIN('login-1'));
    shim.enqueue(NEWSLETTER('news-1'));
    const { tokens } = start({ mx1, quota: QUOTA_FREE });
    await until(() => acked().length === 2, 'both acked');
    expect(mx1.calls.sort()).toEqual(['login-1', 'news-1']);
    expect(tokens.taken).toBe(2);
  });

  it('serves a sweego route by mx1 when the quota is unknown, even with a sweego client', async () => {
    const mx1 = fakeClient();
    const sweego = fakeClient();
    shim.enqueue(LOGIN('login-1'));
    shim.enqueue(NEWSLETTER('news-1'));
    start({ mx1, sweego });
    await until(() => acked().length === 2, 'both acked');
    expect(mx1.calls.sort()).toEqual(['login-1', 'news-1']);
    expect(sweego.calls).toEqual([]);
  });

  it('moves both classes to mx1 once the account cap is reached', async () => {
    const mx1 = fakeClient();
    const sweego = fakeClient();
    shim.enqueue(LOGIN('login-1'));
    shim.enqueue(NEWSLETTER('news-1'));
    const { tokens } = start({
      mx1,
      sweego,
      quota: { allowanceReached: () => false, accountCapReached: () => true },
    });
    await until(() => acked().length === 2, 'both acked');
    expect(mx1.calls).toHaveLength(2);
    expect(sweego.calls).toEqual([]);
    expect(tokens.taken).toBe(2);
  });

  it('moves only newsletters to mx1 once the tenant allowance is reached: login mail never consults the latch', async () => {
    const mx1 = fakeClient();
    const sweego = fakeClient();
    shim.enqueue(LOGIN('login-1'));
    shim.enqueue(NEWSLETTER('news-1'));
    const { tokens, sweegoThrottle } = start({
      mx1,
      sweego,
      quota: { allowanceReached: () => true, accountCapReached: () => false },
    });
    await until(() => acked().length === 2, 'both acked');
    expect(sweego.calls).toEqual(['login-1']);
    expect(mx1.calls).toEqual(['news-1']);
    // The newsletter went through the estate (warm-up) throttle, the login did not.
    expect(tokens.taken).toBe(1);
    expect(sweegoThrottle.taken).toBe(1);
  });

  it('sends a demo to mx1 even if its target names sweego', async () => {
    const mx1 = fakeClient();
    const sweego = fakeClient();
    shim.enqueue(LOGIN('login-1'));
    shim.enqueue(NEWSLETTER('news-1'));
    start({ mx1, sweego, quota: QUOTA_FREE, target: { demo: true } });
    await until(() => acked().length === 2, 'both acked');
    expect(mx1.calls).toHaveLength(2);
    expect(sweego.calls).toEqual([]);
  });

  describe('when sweego does not accept', () => {
    it('falls login mail back to mx1, once, through the throttle, and does not count it against mx1 health', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new TargetSubmissionError('connection refused', 'not-accepted');
      shim.enqueue(LOGIN('login-1'));
      const { health, tokens } = start({ mx1, sweego, quota: QUOTA_FREE });
      await until(() => acked().length === 1, 'login acked');
      expect(sweego.calls).toEqual(['login-1']);
      expect(mx1.calls).toEqual(['login-1']);
      expect(tokens.taken).toBe(1);
      expect(health.consecutiveFailures).toBe(0);
    });

    it('leaves bulk unacked, never tries mx1, and sends it through sweego once sweego recovers', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new TargetSubmissionError('connection refused', 'not-accepted');
      shim.enqueue(NEWSLETTER('news-1'));
      start({ mx1, sweego, quota: QUOTA_FREE });
      await until(() => sweego.calls.length >= 1, 'first sweego try');
      await settle();
      expect(mx1.calls).toEqual([]);
      expect(acked()).toEqual([]);

      sweego.behaviour = () => undefined;
      shim.simulateLostAck();
      await until(() => acked().length === 1, 'bulk acked after recovery');
      expect(sweego.calls.at(-1)).toBe('news-1');
      expect(mx1.calls).toEqual([]);
    });

    it('does not let a held newsletter block a login message behind it in the same batch', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new TargetSubmissionError('connection refused', 'not-accepted');
      shim.enqueue(NEWSLETTER('news-first'));
      shim.enqueue(LOGIN('login-behind'));
      start({ mx1, sweego, quota: QUOTA_FREE });
      await until(() => acked().includes('login-behind'), 'login acked');
      expect(mx1.calls).toEqual(['login-behind']);
      expect(acked()).toEqual(['login-behind']);
    });

    it.each([
      ['an unclassified error', new Error('socket hang up')],
      ['an ambiguous failure', new TargetSubmissionError('timeout after DATA', 'ambiguous')],
    ])('keeps login mail off mx1 after %s, leaving it unacked', async (_label, error) => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => error;
      shim.enqueue(LOGIN('login-1'));
      start({ mx1, sweego, quota: QUOTA_FREE });
      await until(() => sweego.calls.length >= 1, 'first sweego try');
      await settle();
      expect(mx1.calls).toEqual([]);
      expect(acked()).toEqual([]);
    });

    it('never counts sweego failures into the mx1 health counter that gates the heartbeat', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new TargetSubmissionError('refused', 'not-accepted');
      shim.enqueue(NEWSLETTER('news-1'));
      const { health } = start({ mx1, sweego, quota: QUOTA_FREE });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await until(() => sweego.calls.length >= attempt + 1, `sweego try ${attempt + 1}`);
        shim.simulateLostAck();
      }
      expect(sweego.calls.length).toBeGreaterThanOrEqual(6);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.isHealthy(5)).toBe(true);
    });
  });

  describe('hard rule: never mx1 to sweego, for any mail type', () => {
    const MX1_FAILURES: Array<[string, () => Error]> = [
      ['a 4xx at MAIL', () => Object.assign(new Error('451 try later'), { responseCode: 451 })],
      ['a 5xx', () => Object.assign(new Error('554 refused'), { responseCode: 554 })],
      ['a timeout', () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })],
      ['a refused connection', () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })],
      ['a not-accepted failure', () => new TargetSubmissionError('no', 'not-accepted')],
    ];

    it.each([
      ['login', LOGIN],
      ['bulk', NEWSLETTER],
    ])(
      'a failing mx1 never sends %s mail through sweego, however it fails',
      async (_label, build) => {
        const mx1 = fakeClient();
        const sweego = fakeClient();
        let attempt = 0;
        mx1.behaviour = () => MX1_FAILURES[attempt % MX1_FAILURES.length]![1]();
        shim.enqueue(build('m-1'));
        // A mx1 route, with a healthy sweego client and quota beside it: nothing may reach sweego.
        start({ mx1, sweego, quota: QUOTA_FREE, target: { route: 'mx1' } });
        for (attempt = 0; attempt < MX1_FAILURES.length; attempt += 1) {
          await until(() => mx1.calls.length >= attempt + 1, `mx1 try ${attempt + 1}`);
          shim.simulateLostAck();
        }
        expect(mx1.calls.length).toBeGreaterThanOrEqual(MX1_FAILURES.length);
        expect(sweego.calls).toEqual([]);
        expect(acked()).toEqual([]);
      }
    );

    it.each([
      ['login', LOGIN],
      ['bulk', NEWSLETTER],
    ])(
      'a %s message that reached mx1 on a sweego route is never offered to sweego again',
      async (_label, build) => {
        const mx1 = fakeClient();
        const sweego = fakeClient();
        // At the account cap: the message goes to mx1, which fails. Then the quota frees up.
        let quota: SweegoQuota = { allowanceReached: () => false, accountCapReached: () => true };
        const liveQuota: SweegoQuota = {
          allowanceReached: (id) => quota.allowanceReached(id),
          accountCapReached: () => quota.accountCapReached(),
        };
        mx1.behaviour = () => new TargetSubmissionError('mx1 refused', 'not-accepted');
        shim.enqueue(build('m-1'));
        start({ mx1, sweego, quota: liveQuota });
        await until(() => mx1.calls.length >= 1, 'first mx1 try');
        quota = QUOTA_FREE;
        mx1.behaviour = () => new TargetSubmissionError('mx1 refused', 'not-accepted');
        shim.simulateLostAck();
        await until(() => mx1.calls.length >= 2, 'second mx1 try');
        mx1.behaviour = () => undefined;
        shim.simulateLostAck();
        await until(() => acked().length === 1, 'acked through mx1');
        expect(sweego.calls).toEqual([]);
      }
    );

    it('a tenant switched from mx1 to sweego mid-flight cannot send a deferred message through sweego', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      mx1.behaviour = () => new TargetSubmissionError('deferred', 'not-accepted');
      shim.enqueue(LOGIN('login-1'));
      const { store } = start({ mx1, sweego, quota: QUOTA_FREE, target: { route: 'mx1' } });
      await until(() => mx1.calls.length >= 1, 'first mx1 try');
      store.setTargets([{ id: 'tenant-a', baseUrl, route: 'sweego' }]);
      mx1.behaviour = () => undefined;
      shim.simulateLostAck();
      await until(() => acked().length === 1, 'acked through mx1');
      expect(sweego.calls).toEqual([]);
    });

    it('login mail that fell back to mx1 and failed there stays on mx1 for every later offer', async () => {
      const mx1 = fakeClient();
      const sweego = fakeClient();
      sweego.behaviour = () => new TargetSubmissionError('refused', 'not-accepted');
      mx1.behaviour = () => new TargetSubmissionError('mx1 down', 'not-accepted');
      shim.enqueue(LOGIN('login-1'));
      start({ mx1, sweego, quota: QUOTA_FREE });
      await until(() => mx1.calls.length >= 1, 'fallback reached mx1');
      expect(sweego.calls).toEqual(['login-1']);
      // Sweego recovers; mx1 stays down for two more offers, then recovers.
      sweego.behaviour = () => undefined;
      for (let offer = 2; offer <= 3; offer += 1) {
        shim.simulateLostAck();
        await until(() => mx1.calls.length >= offer, `mx1 offer ${offer}`);
      }
      mx1.behaviour = () => undefined;
      shim.simulateLostAck();
      await until(() => acked().length === 1, 'acked through mx1');
      expect(sweego.calls).toEqual(['login-1']);
    });
  });
});
