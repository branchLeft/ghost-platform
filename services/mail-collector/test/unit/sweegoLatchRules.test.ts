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
import { SweegoSubmissionError, type SweegoFailureReason } from '../../src/sweegoFailure.js';
import { createSweegoSuspension, type SweegoSuspension } from '../../src/sweegoSuspension.js';
import { createSweegoUsage, type SweegoUsage } from '../../src/sweegoUsage.js';
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
 * The latch rules in the collector loop: the real counter and the real
 * suspension latch over temp files, a fake clock, both delivery clients
 * doubles. See ../../README.md#sweegousage-createsweegousage.
 */

const NOV = Date.parse('2026-11-15T12:00:00.000Z');
const DEC = Date.parse('2026-12-01T00:00:01.000Z');
const MINUTE = 60_000;

describe('the latch rules in the collector loop', () => {
  let dir: string;
  let clock: number;
  let shim: FakeShimServer;
  let baseUrl: string;
  let runtimes: CollectorRuntime[];
  let lines: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-rules-'));
    clock = NOV;
    runtimes = [];
    lines = [];
    shim = new FakeShimServer(DRAIN_TOKEN);
    baseUrl = await shim.listen();
  });

  afterEach(async () => {
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    await shim.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ownerFile = (): string => join(dir, 'suspend');

  function usageFor(
    options: { accountCap?: number; newsletterCap?: number; suspension?: SweegoSuspension } = {}
  ): SweegoUsage {
    return createSweegoUsage({
      statePath: join(dir, 'usage.json'),
      accountCap: options.accountCap ?? 100,
      ...(options.newsletterCap === undefined ? {} : { newsletterCap: options.newsletterCap }),
      ...(options.suspension ? { suspension: options.suspension } : {}),
      allowanceOf: () => 50,
      now: () => clock,
    });
  }

  function suspensionFor(): SweegoSuspension {
    return createSweegoSuspension({
      statePath: join(dir, 'suspension.json'),
      ownerFilePath: ownerFile(),
      now: () => clock,
    });
  }

  function run(options: {
    targets: DrainTarget[];
    usage: SweegoUsage;
    suspension?: SweegoSuspension;
    mx1: FakeClient;
    sweego: FakeClient;
    sweegoPins?: ReturnType<typeof createSubmittedTracker>;
  }): void {
    const runtime = createCollectorRuntime({
      store: createFakeTargetStore(options.targets),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: options.mx1,
      sweegoDeliveryClient: options.sweego,
      sweegoThrottle: countingThrottle(),
      sweegoQuota: options.usage,
      ...(options.suspension ? { sweegoSuspension: options.suspension } : {}),
      ...(options.sweegoPins ? { sweegoPins: options.sweegoPins } : {}),
      throttle: countingThrottle(),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger((line) => lines.push(line)),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    runtimes.push(runtime);
  }

  const acked = (): string[] => shim.ackRequests.flat().map((a) => a.id);
  const tenant = (id = 'tenant-a'): DrainTarget => ({
    id,
    baseUrl,
    route: 'sweego',
    sweegoAllowance: 50,
  });
  const send = (usage: SweegoUsage, times: number): void => {
    for (let n = 0; n < times; n += 1) {
      usage.begin('tenant-a')!.settle(true);
    }
  };

  describe('the newsletter threshold', () => {
    it('moves newsletters to mx1 and keeps sign-in links on sweego', async () => {
      const usage = usageFor({ accountCap: 100, newsletterCap: 2 });
      send(usage, 2);
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(LOGIN('login-1'));
      shim.enqueue(NEWSLETTER('news-1'));
      run({ targets: [tenant()], usage, mx1, sweego });
      await until(() => acked().length === 2, 'both acked');
      expect(sweego.calls).toEqual(['login-1']);
      expect(mx1.calls).toEqual(['news-1']);
    });

    it('moves the newsletters of every sweego tenant, not only the one that sent', async () => {
      const usage = usageFor({ accountCap: 100, newsletterCap: 2 });
      send(usage, 2);
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(NEWSLETTER('news-b'));
      run({ targets: [tenant('tenant-b')], usage, mx1, sweego });
      await until(() => acked().length === 1, 'acked');
      expect(mx1.calls).toEqual(['news-b']);
      expect(sweego.calls).toEqual([]);
    });

    it('lets the newsletter that reaches the threshold take sweego, and the next go to mx1', async () => {
      const usage = usageFor({ accountCap: 100, newsletterCap: 2 });
      send(usage, 1);
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(NEWSLETTER('news-1'));
      run({ targets: [tenant()], usage, mx1, sweego });
      await until(() => acked().length === 1, 'first acked');
      shim.enqueue(NEWSLETTER('news-2'));
      await until(() => acked().length === 2, 'second acked');
      expect(sweego.calls).toEqual(['news-1']);
      expect(mx1.calls).toEqual(['news-2']);
    });
  });

  describe('the account ceiling', () => {
    it('moves both classes to mx1', async () => {
      const usage = usageFor({ accountCap: 3, newsletterCap: 2 });
      send(usage, 3);
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(LOGIN('login-1'));
      shim.enqueue(NEWSLETTER('news-1'));
      run({ targets: [tenant()], usage, mx1, sweego });
      await until(() => acked().length === 2, 'both acked');
      expect(sweego.calls).toEqual([]);
      expect(mx1.calls.sort()).toEqual(['login-1', 'news-1']);
    });
  });

  describe('a month roll', () => {
    async function afterRollBothGoToSweego(usage: SweegoUsage): Promise<void> {
      clock = DEC;
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(LOGIN('login-1'));
      shim.enqueue(NEWSLETTER('news-1'));
      run({ targets: [tenant()], usage, mx1, sweego });
      await until(() => acked().length === 2, 'both acked');
      expect(sweego.calls.sort()).toEqual(['login-1', 'news-1']);
      expect(mx1.calls).toEqual([]);
    }

    it('clears a tenant latch: its sign-in links and newsletters return to sweego', async () => {
      const usage = createSweegoUsage({
        statePath: join(dir, 'usage.json'),
        accountCap: 100,
        allowanceOf: () => 2,
        now: () => clock,
      });
      send(usage, 2);
      expect(usage.allowanceReached('tenant-a')).toBe(true);
      await afterRollBothGoToSweego(usage);
    });

    it('clears the newsletter threshold', async () => {
      const usage = usageFor({ accountCap: 100, newsletterCap: 2 });
      send(usage, 2);
      expect(usage.newsletterThresholdReached()).toBe(true);
      await afterRollBothGoToSweego(usage);
    });

    it('clears the account ceiling', async () => {
      const usage = usageFor({ accountCap: 2 });
      send(usage, 2);
      expect(usage.accountCapReached()).toBe(true);
      await afterRollBothGoToSweego(usage);
    });

    it('does not clear the suspension latch', async () => {
      const suspension = suspensionFor();
      suspension.recordRefusal('auth');
      clock += 30 * MINUTE;
      suspension.recordRefusal('auth');
      expect(suspension.suspended()).toBe(true);
      clock = DEC;
      const usage = usageFor({ suspension });
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(LOGIN('login-1'));
      shim.enqueue(NEWSLETTER('news-1'));
      run({ targets: [tenant()], usage, suspension, mx1, sweego });
      await until(() => acked().length === 2, 'both acked');
      expect(sweego.calls).toEqual([]);
      expect(mx1.calls.sort()).toEqual(['login-1', 'news-1']);
    });
  });

  describe('a pinned message', () => {
    it('stays on sweego when its tenant is latched and the threshold is reached, and is counted', async () => {
      const usage = createSweegoUsage({
        statePath: join(dir, 'usage.json'),
        accountCap: 100,
        newsletterCap: 2,
        allowanceOf: () => 1,
        now: () => clock,
      });
      send(usage, 2);
      const pins = createSubmittedTracker(60_000);
      pins.markSubmitted('login-1');
      pins.markSubmitted('news-1');
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(LOGIN('login-1'));
      shim.enqueue(NEWSLETTER('news-1'));
      run({ targets: [tenant()], usage, mx1, sweego, sweegoPins: pins });
      await until(() => acked().length === 2, 'both acked');
      expect(sweego.calls.sort()).toEqual(['login-1', 'news-1']);
      expect(mx1.calls).toEqual([]);
      expect(usage.accountState().total).toBe(4);
    });

    it('waits while sweego is suspended: it is not sent to mx1 and not sent to sweego', async () => {
      writeFileSync(ownerFile(), '');
      const suspension = suspensionFor();
      const usage = usageFor({ suspension });
      const pins = createSubmittedTracker(60_000);
      pins.markSubmitted('news-1');
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(NEWSLETTER('news-1'));
      run({ targets: [tenant()], usage, suspension, mx1, sweego, sweegoPins: pins });
      await until(
        () => lines.some((line) => line.includes('sweego_pinned_held_suspended')),
        'held'
      );
      await settle();
      expect(mx1.calls).toEqual([]);
      expect(sweego.calls).toEqual([]);
      expect(acked()).toEqual([]);
    });
  });

  describe('suspension', () => {
    it('sends both classes to mx1 while the owner file exists', async () => {
      writeFileSync(ownerFile(), '');
      const suspension = suspensionFor();
      const usage = usageFor({ suspension });
      const mx1 = fakeClient();
      const sweego = fakeClient();
      shim.enqueue(LOGIN('login-1'));
      shim.enqueue(NEWSLETTER('news-1'));
      run({ targets: [tenant()], usage, suspension, mx1, sweego });
      await until(() => acked().length === 2, 'both acked');
      expect(sweego.calls).toEqual([]);
      expect(mx1.calls.sort()).toEqual(['login-1', 'news-1']);
      expect(usage.accountState().suspended).toBe(true);
    });

    function refusing(reason: SweegoFailureReason): FakeClient {
      const sweego = fakeClient();
      sweego.behaviour = () => new SweegoSubmissionError(reason);
      return sweego;
    }

    it('latches after 30 minutes of authentication refusals, then sends everything to mx1 without trying sweego', async () => {
      const suspension = suspensionFor();
      const usage = usageFor({ suspension });
      const mx1 = fakeClient();
      const sweego = refusing('auth');
      shim.enqueue(LOGIN('login-1'));
      run({ targets: [tenant()], usage, suspension, mx1, sweego });
      await until(() => acked().length === 1, 'first acked');
      expect(sweego.calls).toEqual(['login-1']);
      expect(suspension.suspended()).toBe(false);
      clock += 30 * MINUTE;
      shim.enqueue(LOGIN('login-2'));
      await until(() => acked().length === 2, 'second acked');
      expect(suspension.suspended()).toBe(true);
      expect(mx1.calls).toEqual(['login-1', 'login-2']);
      shim.enqueue(LOGIN('login-3'));
      shim.enqueue(NEWSLETTER('news-3'));
      await until(() => acked().length === 4, 'rest acked');
      expect(sweego.calls).toEqual(['login-1', 'login-2']);
      expect(mx1.calls.sort()).toEqual(['login-1', 'login-2', 'login-3', 'news-3']);
      expect(usage.accountState().suspended).toBe(true);
    });

    it('does not latch at 29 minutes: the next message still tries sweego', async () => {
      const suspension = suspensionFor();
      const usage = usageFor({ suspension });
      const sweego = refusing('credential');
      shim.enqueue(LOGIN('login-1'));
      run({ targets: [tenant()], usage, suspension, mx1: fakeClient(), sweego });
      await until(() => acked().length === 1, 'first acked');
      clock += 29 * MINUTE;
      shim.enqueue(LOGIN('login-2'));
      await until(() => acked().length === 2, 'second acked');
      shim.enqueue(LOGIN('login-3'));
      await until(() => acked().length === 3, 'third acked');
      expect(suspension.suspended()).toBe(false);
      expect(sweego.calls).toEqual(['login-1', 'login-2', 'login-3']);
    });

    it('is reset by one acceptance between the refusals', async () => {
      const suspension = suspensionFor();
      const usage = usageFor({ suspension });
      const sweego = fakeClient();
      sweego.behaviour = (message) =>
        message.id === 'login-2' ? undefined : new SweegoSubmissionError('auth');
      shim.enqueue(LOGIN('login-1'));
      run({ targets: [tenant()], usage, suspension, mx1: fakeClient(), sweego });
      await until(() => acked().length === 1, 'first acked');
      clock += 20 * MINUTE;
      shim.enqueue(LOGIN('login-2'));
      await until(() => acked().length === 2, 'accepted one acked');
      clock += 20 * MINUTE;
      shim.enqueue(LOGIN('login-3'));
      await until(() => acked().length === 3, 'third acked');
      expect(suspension.suspended()).toBe(false);
      expect(suspension.state().runStart).toBe(clock);
    });

    it('is not started by refusals that are neither authentication nor credential', async () => {
      const suspension = suspensionFor();
      const usage = usageFor({ suspension });
      const sweego = refusing('unreachable');
      shim.enqueue(LOGIN('login-1'));
      run({ targets: [tenant()], usage, suspension, mx1: fakeClient(), sweego });
      await until(() => acked().length === 1, 'first acked');
      clock += 60 * MINUTE;
      shim.enqueue(LOGIN('login-2'));
      await until(() => acked().length === 2, 'second acked');
      expect(suspension.suspended()).toBe(false);
      expect(suspension.state().runStart).toBeUndefined();
    });
  });
});
