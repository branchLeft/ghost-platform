import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transporter } from '../../src/smtp.js';
import { createSqliteStore, type QueueBatchPayload, type ShimStore } from '../../src/store.js';
import { createWorker, recipientDomain, type WorkerHandle } from '../../src/worker.js';
import { createTestLogger, type TestLogger } from '../helpers/testLogger.js';
import { createUnlimitedThrottle } from '../helpers/testThrottle.js';
import { createFakeStore } from './helpers/fakeStore.js';

const DOMAIN = 'tenant.example.com';

function payload(overrides: Partial<QueueBatchPayload> = {}): QueueBatchPayload {
  return {
    from: 'noreply@tenant.example.com',
    subject: 'Hi',
    html: '<p>hi</p>',
    text: 'hi',
    headers: {},
    recipientVariables: {},
    ...overrides,
  };
}

describe('recipientDomain', () => {
  it('extracts the domain half of an address', () => {
    expect(recipientDomain('member@example.com')).toBe('example.com');
  });

  it('falls back to "unknown" for something with no @', () => {
    expect(recipientDomain('not-an-address')).toBe('unknown');
  });
});

describe('worker — restart recovery', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-worker-test-'));
    dbPath = join(dir, 'shim.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('only (re)sends rows that were never marked sent before the crash, and never re-sends a sent row', async () => {
    const store1 = createSqliteStore(dbPath);
    store1.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
      now: 0,
    });

    // Simulate a worker that got through recipient "a" only before the
    // process died — "b" and "c" were never even claimed.
    store1.recordRecipientSent('batch-1', 'a@example.com', {
      domain: DOMAIN,
      type: 'delivered',
      severity: null,
      recipient: 'a@example.com',
      emailId: null,
      providerMessageId: '<msg-a@tenant.example.com>',
      timestamp: 0,
      errorCode: null,
      errorMessage: null,
    });
    store1.close();

    // Discard that worker entirely (there never was one — the crash is
    // simulated at the store level) and start fresh against the same file.
    const store2 = createSqliteStore(dbPath);
    const sendMail = vi.fn(async (_params: { to: string }) => ({}));
    const transport = { sendMail } as unknown as Transporter;
    const worker = createWorker({
      store: store2,
      transport,
      throttle: createUnlimitedThrottle(),
      log: createTestLogger().logger,
    });

    // Startup drain — no request ever arrives, this is the whole test.
    await worker.whenIdle();
    await worker.stop();

    const sentTo = sendMail.mock.calls.map((call) => (call[0] as { to: string }).to);
    expect(sentTo.sort()).toEqual(['b@example.com', 'c@example.com']);
    expect(sentTo).not.toContain('a@example.com');

    store2.close();
  });
});

describe('worker — suppression checked at send time', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('marks a recipient suppressed with no event when suppression exists at send time, even though it did not exist at enqueue time', async () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    // Suppressed after enqueue but before the worker gets to it.
    store.addSuppression(DOMAIN, 'bounces', 'member@example.com');

    const sendMail = vi.fn(async () => ({}));
    const transport = { sendMail } as unknown as Transporter;
    const worker = createWorker({
      store,
      transport,
      throttle: createUnlimitedThrottle(),
      log: createTestLogger().logger,
    });

    await worker.whenIdle();
    await worker.stop();

    expect(sendMail).not.toHaveBeenCalled();
    expect(store.listEvents(DOMAIN, { limit: 10, offset: 0 }).events).toHaveLength(0);
    expect(store.countPendingRecipients()).toBe(0);
  });
});

describe('worker — backoff', () => {
  let dir: string;
  let dbPath: string;
  let store: ShimStore;
  let currentTime: number;
  let testLogger: TestLogger;
  let worker: WorkerHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailgun-shim-worker-backoff-'));
    dbPath = join(dir, 'shim.sqlite');
    store = createSqliteStore(dbPath);
    currentTime = 1_700_000_000;
    testLogger = createTestLogger();
  });

  afterEach(async () => {
    await worker.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function createFailingWorker(sendMail: ReturnType<typeof vi.fn>): WorkerHandle {
    const transport = { sendMail } as unknown as Transporter;
    return createWorker({
      store,
      transport,
      throttle: createUnlimitedThrottle(),
      log: testLogger.logger,
      now: () => currentTime,
    });
  }

  it('schedules a retry at each ladder interval for a transient failure, then fails permanently after the attempt cap — recording exactly one failed event', async () => {
    const sendMail = vi.fn(async () => {
      throw new Error('connection reset');
    });
    worker = createFailingWorker(sendMail);

    store.enqueueBatch({
      batchId: 'batch-retry',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['retry@example.com'],
      now: currentTime,
    });

    const ladder = [60, 300, 900, 3600, 14400];
    for (let attempt = 0; attempt < ladder.length; attempt += 1) {
      worker.kick();
      await worker.whenIdle();
      expect(sendMail).toHaveBeenCalledTimes(attempt + 1);
      currentTime += ladder[attempt]!;
    }

    // 6th attempt: the cap is reached, this must be the permanent failure —
    // no further retry gets scheduled.
    worker.kick();
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(6);

    currentTime += 24 * 3600;
    worker.kick();
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(6);

    const failedEvents = store
      .listEvents(DOMAIN, { limit: 10, offset: 0 })
      .events.filter((e) => e.type === 'failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.severity).toBe('permanent');
    expect(store.countPendingRecipients()).toBe(0);
  });

  it('does not retry a permanent (5xx) failure — one attempt, one failed event', async () => {
    const sendMail = vi.fn(async () => {
      const err = new Error('mailbox unavailable') as Error & { responseCode?: number };
      err.responseCode = 550;
      throw err;
    });
    worker = createFailingWorker(sendMail);

    store.enqueueBatch({
      batchId: 'batch-permanent',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['permanent@example.com'],
      now: currentTime,
    });

    worker.kick();
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(1);

    currentTime += 24 * 3600;
    worker.kick();
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(1);

    const failedEvents = store
      .listEvents(DOMAIN, { limit: 10, offset: 0 })
      .events.filter((e) => e.type === 'failed');
    expect(failedEvents).toHaveLength(1);
  });

  it('a transient (4xx) failure retries rather than failing immediately', async () => {
    const sendMail = vi.fn(async () => {
      const err = new Error('too many recipients right now') as Error & { responseCode?: number };
      err.responseCode = 421;
      throw err;
    });
    worker = createFailingWorker(sendMail);

    store.enqueueBatch({
      batchId: 'batch-4xx',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: currentTime,
    });

    worker.kick();
    await worker.whenIdle();
    expect(store.countPendingRecipients()).toBe(1);
    expect(store.listEvents(DOMAIN, { limit: 10, offset: 0 }).events).toHaveLength(0);
  });

  it('treats an unsafe recipient address as a permanent failure, not transient, even though it has no SMTP response code', async () => {
    const sendMail = vi.fn(async () => ({}));
    worker = createFailingWorker(sendMail);

    store.enqueueBatch({
      batchId: 'batch-unsafe',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['bad,address@example.com'],
      now: currentTime,
    });

    worker.kick();
    await worker.whenIdle();

    expect(sendMail).not.toHaveBeenCalled();
    const failedEvents = store
      .listEvents(DOMAIN, { limit: 10, offset: 0 })
      .events.filter((e) => e.type === 'failed');
    expect(failedEvents).toHaveLength(1);
    expect(store.countPendingRecipients()).toBe(0);
  });
});

describe('worker — queue cleanup', () => {
  it('logs queue_cleanup when the startup tick actually deletes completed batches', async () => {
    const store = createFakeStore();
    const cleanupSpy = vi.spyOn(store, 'cleanupCompletedBatches').mockReturnValue(3);
    const sendMail = vi.fn(async () => ({}));
    const transport = { sendMail } as unknown as Transporter;
    const testLogger = createTestLogger();

    const worker = createWorker({
      store,
      transport,
      throttle: createUnlimitedThrottle(),
      log: testLogger.logger,
    });
    await worker.whenIdle();
    await worker.stop();

    expect(cleanupSpy).toHaveBeenCalled();
    expect(
      testLogger.lines.some(
        (line) => line.event === 'queue_cleanup' && line.fields.deletedBatches === 3
      )
    ).toBe(true);
  });
});

describe('worker — stop() mid-flight', () => {
  it('lets an in-flight send finish, but claims no further rows once stopped', async () => {
    const store = createSqliteStore(':memory:');
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com'],
      now: 0,
    });

    let resolveSend: (() => void) | undefined;
    const sendMail = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSend = () => resolve({});
        })
    );
    const transport = { sendMail } as unknown as Transporter;
    const worker = createWorker({
      store,
      transport,
      throttle: createUnlimitedThrottle(),
      log: createTestLogger().logger,
    });

    // Startup drain has claimed both rows and is awaiting the first send.
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    const stopPromise = worker.stop();
    resolveSend?.();
    await stopPromise;

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(store.countPendingRecipients()).toBe(1);
    store.close();
  });
});

describe('worker — self-scheduling idle tick', () => {
  it('picks up a row enqueued directly against the store, with no explicit kick, once the idle tick fires', async () => {
    const store = createSqliteStore(':memory:');
    const sendMail = vi.fn(async () => ({}));
    const transport = { sendMail } as unknown as Transporter;
    const worker = createWorker({
      store,
      transport,
      throttle: createUnlimitedThrottle(),
      log: createTestLogger().logger,
      tickIntervalMs: 10,
    });
    await worker.whenIdle();

    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });

    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await worker.stop();
    store.close();
  });
});

describe('worker — throttle gate', () => {
  let store: ShimStore;
  let worker: WorkerHandle;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
  });

  afterEach(async () => {
    await worker.stop();
    store.close();
  });

  it('stops sending for the tick once the throttle denies a token, leaving the rest pending', async () => {
    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['a@example.com', 'b@example.com', 'c@example.com'],
      now: 0,
    });

    const sendMail = vi.fn(async () => ({}));
    const transport = { sendMail } as unknown as Transporter;
    let allowed = 1;
    const throttle = {
      tryTake: () => {
        if (allowed > 0) {
          allowed -= 1;
          return true;
        }
        return false;
      },
      reload: () => {
        // no-op for this test
      },
      currentRate: () => 1,
    };

    worker = createWorker({ store, transport, throttle, log: createTestLogger().logger });
    await worker.whenIdle();

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(store.countPendingRecipients()).toBe(2);
  });
});

describe('worker — stop()', () => {
  it('stops claiming new work once stopped', async () => {
    const store = createSqliteStore(':memory:');
    const sendMail = vi.fn(async () => ({}));
    const transport = { sendMail } as unknown as Transporter;
    const worker = createWorker({
      store,
      transport,
      throttle: createUnlimitedThrottle(),
      log: createTestLogger().logger,
    });
    await worker.whenIdle();
    await worker.stop();

    store.enqueueBatch({
      batchId: 'batch-1',
      domain: DOMAIN,
      emailId: null,
      payload: payload(),
      recipients: ['member@example.com'],
      now: 0,
    });
    worker.kick();
    await worker.whenIdle();

    expect(sendMail).not.toHaveBeenCalled();
    store.close();
  });
});

describe('worker — status()', () => {
  it('reports lastTickAt null before the startup drain, a timestamp after it, and stopped after stop()', async () => {
    const store = createSqliteStore(':memory:');
    const sendMail = vi.fn(async () => ({}));
    const transport = { sendMail } as unknown as Transporter;
    const worker = createWorker({
      store,
      transport,
      throttle: createUnlimitedThrottle(),
      log: createTestLogger().logger,
    });

    // The startup drain is scheduled but hasn't run a microtask yet.
    expect(worker.status()).toEqual({ lastTickAt: null, stopped: false });

    await worker.whenIdle();
    const afterStartup = worker.status();
    expect(afterStartup.lastTickAt).toEqual(expect.any(Number));
    expect(afterStartup.stopped).toBe(false);

    await worker.stop();
    expect(worker.status().stopped).toBe(true);

    store.close();
  });
});
