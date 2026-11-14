import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime, type CollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import type { SweegoQuota } from '../../src/sendingTarget.js';
import {
  createSweegoUsage,
  type SweegoUseCounter,
  type SweegoUsage,
  type UsageReason,
} from '../../src/sweegoUsage.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import {
  DRAIN_TOKEN,
  NEWSLETTER,
  countingThrottle,
  fakeClient,
  settle,
  until,
  type FakeClient,
} from '../helpers/loopHarness.js';

/**
 * Reservations are durable and a message that already holds a place does not
 * take a second one. The counter is the real one over a temp file with a fake
 * clock; the delivery clients are doubles. See
 * ../../README.md#sweegousage-createsweegousage.
 */

const NOV = Date.parse('2026-11-15T12:00:00.000Z');

describe('the usage counter reserves a place before the send', () => {
  let dir: string;
  let statePath: string;
  let clock: number;
  let reasons: UsageReason[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-reservation-'));
    statePath = join(dir, 'usage.json');
    clock = NOV;
    reasons = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function open(options: { accountCap?: number; path?: string } = {}): SweegoUsage {
    return createSweegoUsage({
      statePath: options.path ?? statePath,
      accountCap: options.accountCap ?? 100,
      allowanceOf: () => 3,
      now: () => clock,
      onReason: (reason) => reasons.push(reason),
    });
  }

  const usedBy = (usage: SweegoUsage, tenant: string): number | undefined =>
    usage.tenantLatchState().find((row) => row.tenant === tenant)?.used;

  const stateOnDisk = (): Record<string, unknown> =>
    JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;

  describe('across a crash', () => {
    it('counts a place reserved before the crash, when the next start reads the file', () => {
      const first = open();
      first.begin('tenant-a', 'm1');
      // The process dies here: the outcome was never recorded.
      const restarted = open();
      expect(usedBy(restarted, 'tenant-a')).toBe(1);
      expect(restarted.accountState().total).toBe(1);
    });

    it('counts every place that was in flight at the crash, so the cap holds', () => {
      const first = open({ accountCap: 3 });
      first.begin('tenant-a', 'm1');
      first.begin('tenant-a', 'm2');
      first.begin('tenant-b', 'm3');
      const restarted = open({ accountCap: 3 });
      expect(restarted.accountState().total).toBe(3);
      expect(restarted.accountCapReached()).toBe(true);
    });

    it('latches a tenant whose allowance the in-flight places reached', () => {
      const first = open();
      first.begin('tenant-a', 'm1');
      first.begin('tenant-a', 'm2');
      first.begin('tenant-a', 'm3');
      expect(open().allowanceReached('tenant-a')).toBe(true);
    });

    it('counts a reserved place that carried no message id', () => {
      open().begin('tenant-a');
      expect(usedBy(open(), 'tenant-a')).toBe(1);
    });

    it('says in a counted reason that a place was recounted, once for each', () => {
      const first = open();
      first.begin('tenant-a', 'm1');
      first.begin('tenant-b', 'm2');
      reasons.length = 0;
      const restarted = open();
      expect(reasons).toEqual(['inflight-recounted', 'inflight-recounted']);
      expect(restarted.reasons()['inflight-recounted']).toBe(2);
    });

    it('counts the place once when the message is then accepted after the restart', () => {
      open().begin('tenant-a', 'm1');
      const restarted = open();
      restarted.begin('tenant-a', 'm1')!.settle(true);
      restarted.begin('tenant-a', 'm1')!.ambiguous();
      expect(usedBy(restarted, 'tenant-a')).toBe(1);
      expect(restarted.accountState().total).toBe(1);
    });

    it('counts a place only once however many times the process restarts', () => {
      open().begin('tenant-a', 'm1');
      open();
      expect(usedBy(open(), 'tenant-a')).toBe(1);
      expect(stateOnDisk()).not.toHaveProperty('inflight');
    });

    it('does not carry a reserved place into the next month', () => {
      open().begin('tenant-a', 'm1');
      clock = Date.parse('2026-12-01T00:00:00.000Z');
      const restarted = open();
      expect(restarted.accountState()).toMatchObject({ month: '2026-12', total: 0 });
    });
  });

  describe('what is written, and when', () => {
    it('writes the reservation before the outcome, as a digest and never as an id', () => {
      open().begin('tenant-a', 'message-id-123');
      const body = stateOnDisk();
      expect(body.inflight).toEqual([{ tenant: 'tenant-a', digest: expect.any(String) }]);
      expect(readFileSync(statePath, 'utf8')).not.toContain('message-id-123');
    });

    it('leaves nothing in flight once the attempt is accepted, refused or ambiguous', () => {
      const usage = open();
      usage.begin('tenant-a', 'm1')!.settle(true);
      expect(stateOnDisk()).not.toHaveProperty('inflight');
      usage.begin('tenant-a', 'm2')!.settle(false);
      expect(stateOnDisk()).not.toHaveProperty('inflight');
      usage.begin('tenant-a', 'm3')!.ambiguous();
      expect(stateOnDisk()).not.toHaveProperty('inflight');
      expect(usedBy(open(), 'tenant-a')).toBe(2);
    });

    it('does not count a refused attempt after a restart', () => {
      open().begin('tenant-a', 'm1')!.settle(false);
      expect(usedBy(open(), 'tenant-a')).toBeUndefined();
    });

    it('keeps the other places in flight when one of them settles', () => {
      const usage = open();
      usage.begin('tenant-a', 'm1');
      usage.begin('tenant-a', 'm2')!.settle(false);
      expect(stateOnDisk().inflight).toHaveLength(1);
      expect(usedBy(open(), 'tenant-a')).toBe(1);
    });
  });

  describe('when the reservation cannot be made durable, the send does not go ahead', () => {
    it('hands back no slot when the state cannot be written, and leaves no place held', () => {
      const blocked = open({ accountCap: 1, path: join(dir, 'blocker', 'usage.json') });
      writeFileSync(join(dir, 'blocker'), 'a file where a directory is needed');
      expect(blocked.begin('tenant-a', 'm1')).toBeUndefined();
      expect(blocked.reasons()['state-write-failed']).toBeGreaterThanOrEqual(1);
      expect(blocked.accountCapReached()).toBe(true);

      rmSync(join(dir, 'blocker'));
      // The refused reservation left nothing behind: the one place under the cap is free.
      expect(blocked.accountCapReached()).toBe(false);
      expect(blocked.begin('tenant-a', 'm1')).toBeDefined();
    });

    it('hands back no slot when the state file is unreadable', () => {
      writeFileSync(statePath, 'not json');
      const usage = open();
      expect(usage.begin('tenant-a', 'm1')).toBeUndefined();
    });

    it('hands back no slot when the state file has vanished', () => {
      open().begin('tenant-a', 'm1')!.settle(true);
      rmSync(statePath);
      const usage = open();
      expect(usage.begin('tenant-a', 'm2')).toBeUndefined();
    });

    it('reads an in-flight list that is not a list as a corrupt file, not as no places', () => {
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          month: '2026-11',
          degraded: false,
          tenants: {},
          inflight: 'x',
        })
      );
      const usage = open();
      expect(usage.accountState().degraded).toBe(true);
      expect(usage.begin('tenant-a', 'm1')).toBeUndefined();
    });

    it('reads an in-flight entry with no tenant as a corrupt file', () => {
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          month: '2026-11',
          degraded: false,
          tenants: {},
          inflight: [{ digest: 'abc' }],
        })
      );
      expect(open().accountState().degraded).toBe(true);
    });

    it('still reads a file written before the in-flight list existed', () => {
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          month: '2026-11',
          degraded: false,
          tenants: { 'tenant-a': { used: 2, latched: false } },
        })
      );
      const usage = open();
      expect(usedBy(usage, 'tenant-a')).toBe(2);
      expect(usage.accountState().degraded).toBe(false);
      expect(usage.begin('tenant-a', 'm1')).toBeDefined();
    });
  });
});

describe('a message that already holds a place does not take another', () => {
  let dir: string;
  let statePath: string;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-held-place-'));
    statePath = join(dir, 'usage.json');
    clock = NOV;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (accountCap = 1): SweegoUsage =>
    createSweegoUsage({
      statePath,
      accountCap,
      allowanceOf: () => 50,
      now: () => clock,
    });

  it('knows a message counted at an ambiguous end holds its place', () => {
    const usage = open();
    usage.begin('tenant-a', 'm1')!.ambiguous();
    expect(usage.holdsPlace('m1')).toBe(true);
    expect(usage.holdsPlace('m2')).toBe(false);
  });

  it('knows it across a restart, including a place recounted from a crash', () => {
    open(5).begin('tenant-a', 'm1');
    expect(open(5).holdsPlace('m1')).toBe(true);
  });

  it('reserves nothing for a retry of such a message: the cap is still exactly full', () => {
    const usage = open();
    usage.begin('tenant-a', 'm1')!.ambiguous();
    expect(usage.accountState()).toMatchObject({ total: 1, capReached: true });
    const retry = usage.begin('tenant-a', 'm1');
    expect(retry).toBeDefined();
    retry?.settle(true);
    expect(usage.accountState().total).toBe(1);
  });

  it('leaves the other places in the account free for other messages meanwhile', () => {
    const usage = open(2);
    usage.begin('tenant-a', 'm1')!.ambiguous();
    const retry = usage.begin('tenant-a', 'm1');
    expect(usage.accountCapReached()).toBe(false);
    retry?.settle(true);
    expect(usage.accountCapReached()).toBe(false);
  });

  it('is not claimed when the counters cannot be trusted', () => {
    const usage = open(5);
    usage.begin('tenant-a', 'm1')!.ambiguous();
    rmSync(statePath);
    expect(open(5).holdsPlace('m1')).toBe(false);
    writeFileSync(statePath, 'garbage');
    expect(open(5).holdsPlace('m1')).toBe(false);
  });

  it('is forgotten when the month changes, as the count is', () => {
    const usage = open(5);
    usage.begin('tenant-a', 'm1')!.ambiguous();
    clock = Date.parse('2026-12-01T00:00:00.000Z');
    expect(usage.holdsPlace('m1')).toBe(false);
  });
});

describe('the collector loop and the reservation', () => {
  let dir: string;
  let statePath: string;
  let clock: number;
  let shims: FakeShimServer[];
  let runtimes: CollectorRuntime[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-reservation-loop-'));
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

  function usageFor(accountCap = 1000): SweegoUsage {
    return createSweegoUsage({
      statePath,
      accountCap,
      allowanceOf: () => 50,
      now: () => clock,
    });
  }

  function run(options: {
    baseUrl: string;
    usage: SweegoQuota & Partial<SweegoUseCounter>;
    mx1: FakeClient;
    sweego: FakeClient;
    sweegoPins?: ReturnType<typeof createSubmittedTracker>;
  }): void {
    const target: DrainTarget = {
      id: 'tenant-a',
      baseUrl: options.baseUrl,
      route: 'sweego',
      sweegoAllowance: 50,
    };
    const runtime = createCollectorRuntime({
      store: createFakeTargetStore([target]),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: options.mx1,
      sweegoDeliveryClient: options.sweego,
      sweegoThrottle: countingThrottle(),
      sweegoQuota: options.usage,
      ...(options.sweegoPins ? { sweegoPins: options.sweegoPins } : {}),
      throttle: countingThrottle(),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    runtimes.push(runtime);
  }

  const ackedIn = (shim: FakeShimServer): string[] => shim.ackRequests.flat().map((a) => a.id);

  it('has written the place down before it hands the message to Sweego, and a crash then still counts it', async () => {
    const { shim, baseUrl } = await newShim();
    const sweego = fakeClient();
    let onDiskAtSend: string | undefined;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sweego.deliver = async (message) => {
      sweego.calls.push(message.id);
      onDiskAtSend = readFileSync(statePath, 'utf8');
      await gate;
    };
    shim.enqueue(NEWSLETTER('news-1'));
    run({ baseUrl, usage: usageFor(), mx1: fakeClient(), sweego });
    await until(() => sweego.calls.length === 1, 'news-1 at sweego');

    expect(onDiskAtSend).toBeDefined();
    expect(JSON.parse(onDiskAtSend ?? '{}').inflight).toHaveLength(1);
    // The process dies with the send in the air: a new one counts the place.
    expect(usageFor().accountState().total).toBe(1);

    release();
    await until(() => ackedIn(shim).length === 1, 'news-1 acked');
  });

  it('holds the message, unpinned and unsent, when the reservation could not be made', async () => {
    const { shim, baseUrl } = await newShim();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    const sweegoPins = createSubmittedTracker(60_000);
    let refused = 0;
    const refusing: SweegoQuota & SweegoUseCounter = {
      allowanceReached: () => false,
      accountCapReached: () => false,
      holdsPlace: () => false,
      begin: () => {
        refused += 1;
        return undefined;
      },
    };
    shim.enqueue(NEWSLETTER('news-1'));
    run({ baseUrl, usage: refusing, mx1, sweego, sweegoPins });
    await until(() => refused >= 1, 'a reservation tried');
    await settle();
    expect(sweego.calls).toEqual([]);
    expect(mx1.calls).toEqual([]);
    expect(ackedIn(shim)).toEqual([]);
    expect(sweegoPins.has('news-1')).toBe(false);
  });

  it('sends a pinned retry of a message that is already counted even at the cap, and counts it once', async () => {
    const { shim, baseUrl } = await newShim();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    sweego.behaviour = () => new Error('socket hang up');
    const usage = usageFor(1);
    shim.enqueue(NEWSLETTER('news-1'));
    run({ baseUrl, usage, mx1, sweego });
    await until(() => sweego.calls.length >= 1, 'the ambiguous try');
    await settle();
    // The one place under the cap is the message's own.
    expect(usage.accountState()).toMatchObject({ total: 1, capReached: true });

    sweego.behaviour = () => undefined;
    shim.simulateLostAck();
    await until(() => ackedIn(shim).length === 1, 'acked after the retry');
    expect(sweego.calls).toEqual(['news-1', 'news-1']);
    expect(mx1.calls).toEqual([]);
    expect(usage.accountState().total).toBe(1);
  });

  it('still holds a different pinned message at the cap while a counted one is retried', async () => {
    const { shim, baseUrl } = await newShim();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    sweego.behaviour = (message) => (message.id === 'news-1' ? new Error('timeout') : undefined);
    const usage = usageFor(1);
    const sweegoPins = createSubmittedTracker(60_000);
    sweegoPins.markSubmitted('news-other');
    shim.enqueue(NEWSLETTER('news-1'));
    run({ baseUrl, usage, mx1, sweego, sweegoPins });
    await until(() => sweego.calls.length >= 1, 'the ambiguous try');
    shim.enqueue(NEWSLETTER('news-other'));
    await settle();
    expect(sweego.calls).not.toContain('news-other');
    expect(mx1.calls).toEqual([]);
    expect(usage.accountState().total).toBe(1);
  });
});

describe('how long a pinned retry can be held at the cap', () => {
  let dir: string;
  let statePath: string;
  let clock: number;
  let shim: FakeShimServer;
  let runtime: CollectorRuntime | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-hold-bound-'));
    statePath = join(dir, 'usage.json');
    clock = Date.parse('2026-11-10T09:00:00.000Z');
    shim = new FakeShimServer(DRAIN_TOKEN);
  });

  afterEach(async () => {
    await runtime?.stop();
    await shim.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ends at the first instant of the next UTC month and not before: one millisecond earlier it is still held', async () => {
    const baseUrl = await shim.listen();
    const mx1 = fakeClient();
    const sweego = fakeClient();
    const usage = createSweegoUsage({
      statePath,
      accountCap: 1,
      allowanceOf: () => 50,
      now: () => clock,
    });
    usage.begin('tenant-a', 'other')!.settle(true);
    const sweegoPins = createSubmittedTracker(60_000);
    sweegoPins.markSubmitted('news-pinned');
    shim.enqueue(NEWSLETTER('news-pinned'));
    const target: DrainTarget = { id: 'tenant-a', baseUrl, route: 'sweego', sweegoAllowance: 50 };
    runtime = createCollectorRuntime({
      store: createFakeTargetStore([target]),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: mx1,
      sweegoDeliveryClient: sweego,
      sweegoThrottle: countingThrottle(),
      sweegoQuota: usage,
      sweegoPins,
      throttle: countingThrottle(),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();

    clock = Date.parse('2026-11-30T23:59:59.999Z');
    shim.simulateLostAck();
    await settle();
    expect(sweego.calls).toEqual([]);
    expect(shim.ackRequests.flat()).toEqual([]);

    clock = Date.parse('2026-12-01T00:00:00.000Z');
    shim.simulateLostAck();
    await until(() => shim.ackRequests.flat().length === 1, 'sent at the month start');
    expect(sweego.calls).toEqual(['news-pinned']);
    expect(mx1.calls).toEqual([]);
  });
});
