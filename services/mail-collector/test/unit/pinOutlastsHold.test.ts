import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime, type CollectorRuntime } from '../../src/collectorLoop.js';
import { loadConfig } from '../../src/config.js';
import { createSubmittedTracker, type SubmittedTracker } from '../../src/dedupe.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import { createDrainClient } from '../../src/drainClient.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import {
  DEFAULT_PIN_TTL_MS,
  MAX_CAP_HOLD_MS,
  createSweegoUsage,
  type SweegoUsage,
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
} from '../helpers/loopHarness.js';

/**
 * A pinned message held at the Sweego account cap stays pinned for as long as
 * the hold lasts, which can be a whole UTC month. See
 * ../../README.md#dedupe-createsubmittedtracker.
 */

const DAY = 24 * 60 * 60 * 1000;
const BASE_ENV = {
  COLLECTOR_DESCRIPTOR_DIR: '/tmp/descriptors',
  COLLECTOR_DRAIN_TOKEN: 'token',
  COLLECTOR_SMTP_HOST: 'mx1.example.internal',
  COLLECTOR_SMTP_USER: 'collector',
  COLLECTOR_SMTP_PASS: 'secret',
  COLLECTOR_HEARTBEAT_URL: 'https://heartbeat.example/ping',
};

describe('the pin TTL bound', () => {
  it('is the longest UTC calendar month, worked out from the calendar', () => {
    let longest = 0;
    for (let year = 2024; year < 2032; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const days = (Date.UTC(year, month + 1, 1) - Date.UTC(year, month, 1)) / DAY;
        longest = Math.max(longest, days);
      }
    }
    expect(MAX_CAP_HOLD_MS).toBe(longest * DAY);
  });

  it('is covered by the default with four days to spare', () => {
    expect(DEFAULT_PIN_TTL_MS).toBe(MAX_CAP_HOLD_MS + 4 * DAY);
    expect(DEFAULT_PIN_TTL_MS).toBe(35 * DAY);
    expect(loadConfig(BASE_ENV).pinTtlMs).toBe(DEFAULT_PIN_TTL_MS);
  });
});

describe('start-up refuses a pin TTL shorter than the longest cap hold', () => {
  it('refuses a TTL one millisecond below the bound', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, COLLECTOR_PIN_TTL_MS: String(MAX_CAP_HOLD_MS - 1) })
    ).toThrow(/COLLECTOR_PIN_TTL_MS .* below the longest Sweego cap hold/);
  });

  it('refuses the old seven day default when it is set by hand', () => {
    expect(() => loadConfig({ ...BASE_ENV, COLLECTOR_PIN_TTL_MS: String(7 * DAY) })).toThrow(
      /COLLECTOR_PIN_TTL_MS/
    );
  });

  it('accepts a TTL exactly at the bound, and one above it', () => {
    expect(
      loadConfig({ ...BASE_ENV, COLLECTOR_PIN_TTL_MS: String(MAX_CAP_HOLD_MS) }).pinTtlMs
    ).toBe(MAX_CAP_HOLD_MS);
    expect(
      loadConfig({ ...BASE_ENV, COLLECTOR_PIN_TTL_MS: String(MAX_CAP_HOLD_MS + 1) }).pinTtlMs
    ).toBe(MAX_CAP_HOLD_MS + 1);
  });
});

describe('a tracker sweep with a keep rule', () => {
  it('drops an old id unless the rule names it, and never drops a named one', () => {
    let clock = 1_000_000;
    const tracker = createSubmittedTracker(1000, () => clock);
    tracker.markSubmitted('held');
    tracker.markSubmitted('other');
    clock += 5000;
    tracker.sweep((id) => id === 'held');
    expect(tracker.has('held')).toBe(true);
    expect(tracker.has('other')).toBe(false);
    tracker.sweep();
    expect(tracker.has('held')).toBe(false);
  });
});

describe('a pinned retry held at the cap on day 8', () => {
  let dir: string;
  let statePath: string;
  let clock: number;
  let shim: FakeShimServer;
  let runtime: CollectorRuntime | undefined;
  let lines: string[];

  const DAY_0 = Date.parse('2026-11-10T09:00:00.000Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-pin-hold-'));
    statePath = join(dir, 'usage.json');
    clock = DAY_0;
    shim = new FakeShimServer(DRAIN_TOKEN);
    lines = [];
  });

  afterEach(async () => {
    await runtime?.stop();
    await shim.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(sweegoPins: SubmittedTracker): Promise<{
    usage: SweegoUsage;
    mx1: ReturnType<typeof fakeClient>;
    sweego: ReturnType<typeof fakeClient>;
  }> {
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
      log: createLogger((line) => lines.push(line)),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
      dedupeSweepMs: 20,
    });
    runtime.start();
    return { usage, mx1, sweego };
  }

  it('stays pinned under the default TTL: not released, not counted twice, not sent to mx1', async () => {
    // The message was pinned on day 0; the collector has been down or idle,
    // so the pin is swept (on day 8) before the message is offered again.
    const sweegoPins = createSubmittedTracker(DEFAULT_PIN_TTL_MS, () => clock);
    sweegoPins.markSubmitted('news-pinned');
    clock = DAY_0 + 8 * DAY;
    const { usage, mx1, sweego } = await start(sweegoPins);
    await settle();
    shim.enqueue(NEWSLETTER('news-pinned'));
    // Whichever comes first: the hold, or a send that decided the message afresh.
    await until(
      () =>
        lines.some((line) => line.includes('sweego_pinned_held_at_cap')) ||
        mx1.calls.length + sweego.calls.length > 0,
      'the hold or a send'
    );
    await settle();

    expect(mx1.calls).toEqual([]);
    expect(sweegoPins.has('news-pinned')).toBe(true);
    expect(sweego.calls).toEqual([]);
    expect(mx1.calls).toEqual([]);
    expect(shim.ackRequests.flat()).toEqual([]);
    expect(usage.accountState().total).toBe(1);
  });

  it('is not swept while it is held, even when its TTL is short', async () => {
    // A TTL below the bound cannot be configured, but the sweep must still
    // not drop a pin for a message the last offer left held at the cap.
    const sweegoPins = createSubmittedTracker(7 * DAY, () => clock);
    sweegoPins.markSubmitted('news-pinned');
    shim.enqueue(NEWSLETTER('news-pinned'));
    clock = DAY_0 + 1 * DAY;
    const { usage, mx1, sweego } = await start(sweegoPins);
    await until(() => lines.some((line) => line.includes('sweego_pinned_held_at_cap')), 'the hold');

    clock = DAY_0 + 8 * DAY;
    await settle();
    expect(sweegoPins.has('news-pinned')).toBe(true);

    shim.simulateLostAck();
    await settle();
    expect(sweegoPins.has('news-pinned')).toBe(true);
    expect(sweego.calls).toEqual([]);
    expect(mx1.calls).toEqual([]);
    expect(shim.ackRequests.flat()).toEqual([]);
    expect(usage.accountState().total).toBe(1);
  });
});
