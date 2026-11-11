import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime, type CollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { createSweegoUsage, type SweegoUsage } from '../../src/sweegoUsage.js';
import type { Throttle } from '../../src/throttle.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import {
  DRAIN_TOKEN,
  LOGIN,
  NEWSLETTER,
  countingThrottle,
  fakeClient,
  settle,
  until,
  type FakeClient,
} from '../helpers/loopHarness.js';

/**
 * The allowance latch, tested without Sweego: the counter is the real one
 * over a temp file, the clock is fake, both delivery clients are doubles.
 * See ../../README.md#sweegousage-createsweegousage.
 */

const NOV = Date.parse('2026-11-15T12:00:00.000Z');

describe('the allowance latch in the collector loop', () => {
  let dir: string;
  let statePath: string;
  let clock: number;
  let shims: FakeShimServer[];
  let runtimes: CollectorRuntime[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-latch-'));
    statePath = join(dir, 'usage.json');
    clock = NOV;
    shims = [];
    runtimes = [];
  });

  afterEach(async () => {
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    await Promise.allSettled(shims.map((shim) => shim.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function newShim(): Promise<{ shim: FakeShimServer; baseUrl: string }> {
    const shim = new FakeShimServer(DRAIN_TOKEN);
    shims.push(shim);
    return { shim, baseUrl: await shim.listen() };
  }

  function usageFor(allowances: Record<string, number>, accountCap = 1000): SweegoUsage {
    return createSweegoUsage({
      statePath,
      accountCap,
      allowanceOf: (id) => allowances[id],
      now: () => clock,
    });
  }

  function run(options: {
    targets: DrainTarget[];
    usage: SweegoUsage;
    mx1: FakeClient;
    sweego: FakeClient;
    estateThrottle?: Throttle;
    sweegoThrottle?: Throttle;
    sweegoPins?: ReturnType<typeof createSubmittedTracker>;
  }): { estateTaken: () => number } {
    let taken = 0;
    const estate: Throttle = options.estateThrottle ?? {
      tryTake: () => true,
      waitForToken: async () => {
        taken += 1;
      },
      reload() {},
      currentRate: () => 0,
    };
    const runtime = createCollectorRuntime({
      store: createFakeTargetStore(options.targets),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: options.mx1,
      sweegoDeliveryClient: options.sweego,
      sweegoThrottle: options.sweegoThrottle ?? countingThrottle(),
      sweegoQuota: options.usage,
      ...(options.sweegoPins ? { sweegoPins: options.sweegoPins } : {}),
      throttle: estate,
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    runtimes.push(runtime);
    return { estateTaken: () => taken };
  }

  const ackedIn = (shim: FakeShimServer): string[] => shim.ackRequests.flat().map((a) => a.id);
  const tenant = (baseUrl: string, id = 'tenant-a', sweegoAllowance = 2): DrainTarget => ({
    id,
    baseUrl,
    route: 'sweego',
    sweegoAllowance,
  });

  it('sends newsletters through sweego up to the allowance, then through mx1 at the estate throttle, late and not lost', async () => {
    const { shim, baseUrl } = await newShim();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    for (const id of ['news-1', 'news-2', 'news-3', 'news-4']) shim.enqueue(NEWSLETTER(id));
    const usage = usageFor({ 'tenant-a': 2 });
    const { estateTaken } = run({ targets: [tenant(baseUrl)], usage, mx1, sweego });
    await until(() => ackedIn(shim).length === 4, 'all four acked');
    expect(sweego.calls).toEqual(['news-1', 'news-2']);
    expect(mx1.calls).toEqual(['news-3', 'news-4']);
    expect(estateTaken()).toBe(2);
    expect(usage.allowanceReached('tenant-a')).toBe(true);
  });

  it('leaves login mail unaffected by the latch: it still goes to sweego, never through the estate throttle', async () => {
    const { shim, baseUrl } = await newShim();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    const usage = usageFor({ 'tenant-a': 1 });
    usage.begin('tenant-a').settle(true);
    expect(usage.allowanceReached('tenant-a')).toBe(true);
    shim.enqueue(LOGIN('login-1'));
    shim.enqueue(NEWSLETTER('news-1'));
    shim.enqueue(LOGIN('login-2'));
    const { estateTaken } = run({ targets: [tenant(baseUrl, 'tenant-a', 1)], usage, mx1, sweego });
    await until(() => ackedIn(shim).length === 3, 'all acked');
    expect(sweego.calls.sort()).toEqual(['login-1', 'login-2']);
    expect(mx1.calls).toEqual(['news-1']);
    expect(estateTaken()).toBe(1);
  });

  it('counts login mail that sweego took, so the plan total stays true', async () => {
    const { shim, baseUrl } = await newShim();
    const usage = usageFor({ 'tenant-a': 10 });
    shim.enqueue(LOGIN('login-1'));
    shim.enqueue(NEWSLETTER('news-1'));
    run({
      targets: [tenant(baseUrl, 'tenant-a', 10)],
      usage,
      mx1: fakeClient(),
      sweego: fakeClient(),
    });
    await until(() => ackedIn(shim).length === 2, 'both acked');
    expect(usage.accountState().total).toBe(2);
  });

  it('counts only what sweego accepted: a refused or ambiguous attempt uses none of the allowance', async () => {
    const { shim, baseUrl } = await newShim();
    const sweego = fakeClient();
    sweego.behaviour = () => new Error('socket hang up');
    const usage = usageFor({ 'tenant-a': 1 });
    shim.enqueue(NEWSLETTER('news-1'));
    run({ targets: [tenant(baseUrl, 'tenant-a', 1)], usage, mx1: fakeClient(), sweego });
    await until(() => sweego.calls.length >= 1, 'a sweego try');
    await settle();
    expect(usage.accountState().total).toBe(0);
    expect(usage.allowanceReached('tenant-a')).toBe(false);
  });

  it('keeps the latch across a restart: a new process sends the next newsletter through mx1', async () => {
    const first = await newShim();
    const usage = usageFor({ 'tenant-a': 1 });
    first.shim.enqueue(NEWSLETTER('news-1'));
    const sweego = fakeClient();
    run({ targets: [tenant(first.baseUrl, 'tenant-a', 1)], usage, mx1: fakeClient(), sweego });
    await until(() => ackedIn(first.shim).length === 1, 'first acked');
    expect(sweego.calls).toEqual(['news-1']);
    await runtimes.pop()!.stop();

    const second = await newShim();
    const restarted = usageFor({ 'tenant-a': 1 });
    const mx1 = fakeClient();
    const sweegoAgain = fakeClient();
    second.shim.enqueue(NEWSLETTER('news-2'));
    run({
      targets: [tenant(second.baseUrl, 'tenant-a', 1)],
      usage: restarted,
      mx1,
      sweego: sweegoAgain,
    });
    await until(() => ackedIn(second.shim).length === 1, 'second acked');
    expect(mx1.calls).toEqual(['news-2']);
    expect(sweegoAgain.calls).toEqual([]);
  });

  it('sends the next newsletter through sweego again once the month has rolled over', async () => {
    const { shim, baseUrl } = await newShim();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    const usage = usageFor({ 'tenant-a': 1 });
    shim.enqueue(NEWSLETTER('news-1'));
    shim.enqueue(NEWSLETTER('news-2'));
    run({ targets: [tenant(baseUrl, 'tenant-a', 1)], usage, mx1, sweego });
    await until(() => ackedIn(shim).length === 2, 'both acked');
    expect(sweego.calls).toEqual(['news-1']);
    expect(mx1.calls).toEqual(['news-2']);

    clock = Date.parse('2026-12-01T00:00:00.000Z');
    shim.enqueue(NEWSLETTER('news-3'));
    await until(() => ackedIn(shim).length === 3, 'third acked');
    expect(sweego.calls).toEqual(['news-1', 'news-3']);
    expect(mx1.calls).toEqual(['news-2']);
  });

  it('latches each tenant on its own allowance', async () => {
    const a = await newShim();
    const b = await newShim();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    for (const id of ['a-1', 'a-2']) a.shim.enqueue(NEWSLETTER(id));
    for (const id of ['b-1', 'b-2']) b.shim.enqueue(NEWSLETTER(id));
    const usage = usageFor({ 'tenant-a': 1, 'tenant-b': 5 });
    run({
      targets: [tenant(a.baseUrl, 'tenant-a', 1), tenant(b.baseUrl, 'tenant-b', 5)],
      usage,
      mx1,
      sweego,
    });
    await until(() => ackedIn(a.shim).length === 2 && ackedIn(b.shim).length === 2, 'all acked');
    expect(sweego.calls.sort()).toEqual(['a-1', 'b-1', 'b-2']);
    expect(mx1.calls).toEqual(['a-2']);
  });

  describe('pin beats latch', () => {
    it('keeps a message already pinned to sweego on sweego after its tenant latched, and counts it', async () => {
      const { shim, baseUrl } = await newShim();
      const mx1 = fakeClient();
      const sweego = fakeClient();
      const usage = usageFor({ 'tenant-a': 1 });
      usage.begin('tenant-a').settle(true);
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      const sweegoPins = createSubmittedTracker(60_000);
      sweegoPins.markSubmitted('news-pinned');
      shim.enqueue(NEWSLETTER('news-pinned'));
      shim.enqueue(NEWSLETTER('news-fresh'));
      run({
        targets: [tenant(baseUrl, 'tenant-a', 1)],
        usage,
        mx1,
        sweego,
        sweegoPins,
      });
      await until(() => ackedIn(shim).length === 2, 'both acked');
      expect(sweego.calls).toEqual(['news-pinned']);
      expect(mx1.calls).toEqual(['news-fresh']);
      expect(usage.accountState().total).toBe(2);
    });
  });

  describe('the account-wide cap', () => {
    it('sends every tenant through mx1 once the total reaches the cap, whatever each allowance says', async () => {
      const a = await newShim();
      const b = await newShim();
      const mx1 = fakeClient();
      const sweego = fakeClient();
      const usage = usageFor({ 'tenant-a': 50, 'tenant-b': 50 }, 2);
      a.shim.enqueue(NEWSLETTER('a-1'));
      b.shim.enqueue(NEWSLETTER('b-1'));
      run({
        targets: [tenant(a.baseUrl, 'tenant-a', 50), tenant(b.baseUrl, 'tenant-b', 50)],
        usage,
        mx1,
        sweego,
      });
      await until(() => ackedIn(a.shim).length === 1 && ackedIn(b.shim).length === 1, 'acked');
      expect(sweego.calls.sort()).toEqual(['a-1', 'b-1']);
      a.shim.enqueue(NEWSLETTER('a-2'));
      b.shim.enqueue(LOGIN('b-login'));
      await until(() => ackedIn(a.shim).length === 2 && ackedIn(b.shim).length === 2, 'later');
      expect(sweego.calls.sort()).toEqual(['a-1', 'b-1']);
      expect(mx1.calls.sort()).toEqual(['a-2', 'b-login']);
      expect(usage.accountState().total).toBe(2);
    });

    it('holds the total inside the cap when two tenants have a message in flight at once', async () => {
      const a = await newShim();
      const b = await newShim();
      const mx1 = fakeClient();
      const sweego = fakeClient();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inner = sweego.deliver.bind(sweego);
      sweego.deliver = async (message, targetId) => {
        await inner(message, targetId);
        await gate;
      };
      const usage = usageFor({ 'tenant-a': 50, 'tenant-b': 50 }, 1);
      a.shim.enqueue(NEWSLETTER('a-1'));
      run({
        targets: [tenant(a.baseUrl, 'tenant-a', 50), tenant(b.baseUrl, 'tenant-b', 50)],
        usage,
        mx1,
        sweego,
      });
      await until(() => sweego.calls.length === 1, 'a-1 in flight at sweego');
      b.shim.enqueue(NEWSLETTER('b-1'));
      await until(() => ackedIn(b.shim).length === 1, 'b-1 acked through mx1');
      expect(mx1.calls).toEqual(['b-1']);
      release();
      await until(() => ackedIn(a.shim).length === 1, 'a-1 acked');
      expect(sweego.calls).toEqual(['a-1']);
      expect(usage.accountState().total).toBe(1);
    });
  });

  it('asks again after waiting on the sweego throttle: a latch that arrived meanwhile sends the newsletter to mx1', async () => {
    const { shim, baseUrl } = await newShim();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    let open: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached = false;
    const gatedThrottle: Throttle = {
      tryTake: () => true,
      waitForToken: async () => {
        reached = true;
        await waiting;
      },
      reload() {},
      currentRate: () => 0,
    };
    const usage = usageFor({ 'tenant-a': 1 });
    shim.enqueue(NEWSLETTER('news-1'));
    run({
      targets: [tenant(baseUrl, 'tenant-a', 1)],
      usage,
      mx1,
      sweego,
      sweegoThrottle: gatedThrottle,
    });
    await until(() => reached, 'the message is waiting on the sweego throttle');
    usage.begin('tenant-a').settle(true);
    open();
    await until(() => ackedIn(shim).length === 1, 'acked');
    expect(mx1.calls).toEqual(['news-1']);
    expect(sweego.calls).toEqual([]);
  });

  it('sends nothing to sweego when the counter cannot be trusted: a corrupt file latches everyone', async () => {
    const { shim, baseUrl } = await newShim();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    writeFileSync(statePath, '{broken');
    const usage = usageFor({ 'tenant-a': 1000 });
    shim.enqueue(NEWSLETTER('news-1'));
    shim.enqueue(LOGIN('login-1'));
    run({ targets: [tenant(baseUrl, 'tenant-a', 1000)], usage, mx1, sweego });
    await until(() => ackedIn(shim).length === 2, 'both acked');
    expect(sweego.calls).toEqual([]);
    expect(mx1.calls.sort()).toEqual(['login-1', 'news-1']);
    expect(usage.reasons()['state-corrupt']).toBe(1);
  });
});
