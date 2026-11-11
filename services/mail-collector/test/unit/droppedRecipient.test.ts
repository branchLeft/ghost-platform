import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollectorRuntime, type CollectorRuntime } from '../../src/collectorLoop.js';
import { createSubmittedTracker } from '../../src/dedupe.js';
import { createDrainClient, type DrainClient, type OutcomeClient } from '../../src/drainClient.js';
import { createDroppedOutcomes, type DroppedOutcomes } from '../../src/droppedOutcomes.js';
import { createHealthState } from '../../src/health.js';
import { createLogger } from '../../src/log.js';
import { TargetSubmissionError } from '../../src/sendingTarget.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';
import {
  DRAIN_TOKEN,
  NEWSLETTER,
  QUOTA_FREE,
  countingThrottle,
  fakeClient,
  settle,
  until,
} from '../helpers/loopHarness.js';

/**
 * A recipient Sweego refuses for good is acked and dropped; the spool is then
 * told it failed, over its existing outcome route. See
 * ../../README.md#a-dropped-recipient-reported-back-to-the-spool.
 */
describe('a dropped recipient reported back to the spool', () => {
  let shim: FakeShimServer;
  let baseUrl: string;
  let runtime: CollectorRuntime | undefined;
  let events: string[];
  let logLines: string[];
  let reporter: DroppedOutcomes;
  let lostAcks: number;

  beforeEach(async () => {
    shim = new FakeShimServer(DRAIN_TOKEN);
    shim.outcomesEnabled = true;
    baseUrl = await shim.listen();
    events = [];
    logLines = [];
    lostAcks = 0;
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    await shim.close();
  });

  function start(options: { retryMs?: number; giveUpMs?: number } = {}): void {
    const real = createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 });
    const client: DrainClient & OutcomeClient = {
      drain: real.drain,
      ack: async (target, acks, signal) => {
        if (lostAcks > 0) {
          lostAcks -= 1;
          throw new Error('ack lost');
        }
        const result = await real.ack(target, acks, signal);
        events.push('ack');
        return result;
      },
      reportOutcomes: async (target, outcomes, signal) => {
        events.push('outcome');
        return real.reportOutcomes(target, outcomes, signal);
      },
    };
    const log = createLogger((line) => logLines.push(line));
    reporter = createDroppedOutcomes({
      client,
      log,
      retryMs: options.retryMs ?? 30,
      giveUpMs: options.giveUpMs ?? 60_000,
    });
    const sweego = fakeClient();
    sweego.behaviour = (message) =>
      message.id.startsWith('bad')
        ? new TargetSubmissionError('refused', 'recipient-rejected')
        : undefined;
    runtime = createCollectorRuntime({
      store: createFakeTargetStore([{ id: 'tenant-a', baseUrl, route: 'sweego' }]),
      drainClient: client,
      droppedOutcomes: reporter,
      deliveryClient: fakeClient(),
      sweegoDeliveryClient: sweego,
      sweegoThrottle: countingThrottle(),
      sweegoQuota: QUOTA_FREE,
      throttle: countingThrottle(),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log,
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
  }

  const acked = (): string[] => shim.ackRequests.flat().map((ack) => ack.id);
  const reported = (): Array<Record<string, unknown>> => shim.outcomeRequests.flat();

  it('reports a permanent failure for the dropped message, after its ack, and for no other', async () => {
    shim.enqueue(NEWSLETTER('bad-1'));
    shim.enqueue(NEWSLETTER('good-1'));
    start();
    await until(() => reported().length === 1, 'the failure reported');
    await settle();
    expect(acked().sort()).toEqual(['bad-1', 'good-1']);
    expect(reported()).toEqual([
      expect.objectContaining({
        id: 'bad-1',
        drainCount: 1,
        outcome: 'failed',
        severity: 'permanent',
      }),
    ]);
    expect(events.indexOf('outcome')).toBeGreaterThan(events.indexOf('ack'));
    expect(reporter.pending).toBe(0);
  });

  it('puts no address, subject or body in what it tells the spool or logs', async () => {
    shim.enqueue(NEWSLETTER('bad-1'));
    start();
    await until(() => reported().length === 1, 'the failure reported');
    const everything = JSON.stringify(reported()) + logLines.join('\n');
    expect(everything).not.toContain('reader-bad-1@example.com');
    expect(everything).not.toContain('Subject bad-1');
    expect(everything).not.toContain('<p>bad-1</p>');
  });

  it('reports nothing for mail that was delivered', async () => {
    shim.enqueue(NEWSLETTER('good-1'));
    start();
    await until(() => acked().length === 1, 'acked');
    await settle();
    expect(reported()).toEqual([]);
  });

  it('waits for the ack: with the ack lost it reports nothing, then reports the new generation after the re-offer', async () => {
    shim.enqueue(NEWSLETTER('bad-1'));
    lostAcks = 1;
    start();
    await until(() => lostAcks === 0, 'the first ack lost');
    await settle();
    expect(reported()).toEqual([]);
    shim.simulateLostAck();
    await until(() => reported().length === 1, 'reported after the re-offer');
    expect(reported()[0]).toMatchObject({ id: 'bad-1', drainCount: 2 });
    expect(acked()).toEqual(['bad-1']);
  });

  it('tries again when the spool has not opted in, and reports once it has', async () => {
    shim.outcomesEnabled = false;
    shim.enqueue(NEWSLETTER('bad-1'));
    start();
    await until(
      () => logLines.some((line) => line.includes('dropped_outcome_report_failed')),
      'the failure logged'
    );
    expect(acked()).toEqual(['bad-1']);
    expect(reporter.pending).toBe(1);
    shim.outcomesEnabled = true;
    await until(() => reported().length === 1, 'reported once enabled');
    expect(reporter.pending).toBe(0);
  });

  it('keeps the report while the spool answers unknown, and drops it once recorded', async () => {
    shim.unknownOutcomeIds.add('bad-1');
    shim.enqueue(NEWSLETTER('bad-1'));
    start();
    await until(() => shim.outcomeRequests.length >= 2, 'asked more than once');
    expect(reporter.pending).toBe(1);
    shim.unknownOutcomeIds.clear();
    await until(() => reporter.pending === 0, 'recorded');
  });

  it('gives up on a report the spool never takes, and says so', async () => {
    shim.outcomesEnabled = false;
    shim.enqueue(NEWSLETTER('bad-1'));
    start({ giveUpMs: 150 });
    await until(
      () => logLines.some((line) => line.includes('dropped_outcome_abandoned')),
      'given up'
    );
    expect(reporter.pending).toBe(0);
    expect(acked()).toEqual(['bad-1']);
  });

  it('is off when no reporter is supplied: the message is still acked and the spool is told nothing', async () => {
    shim.enqueue(NEWSLETTER('bad-1'));
    const sweego = fakeClient();
    sweego.behaviour = () => new TargetSubmissionError('refused', 'recipient-rejected');
    runtime = createCollectorRuntime({
      store: createFakeTargetStore([{ id: 'tenant-a', baseUrl, route: 'sweego' }]),
      drainClient: createDrainClient({ drainToken: DRAIN_TOKEN, drainTimeoutMs: 5000 }),
      deliveryClient: fakeClient(),
      sweegoDeliveryClient: sweego,
      sweegoThrottle: countingThrottle(),
      sweegoQuota: QUOTA_FREE,
      throttle: countingThrottle(),
      dedupe: createSubmittedTracker(60_000),
      health: createHealthState(),
      log: createLogger(() => {}),
      descriptorRefreshMs: 50,
      drainRetryBackoffMs: 50,
      emptyPollBackoffMs: 20,
    });
    runtime.start();
    await until(() => acked().length === 1, 'acked');
    await settle();
    expect(reported()).toEqual([]);
  });
});

describe('the dropped-outcome queue on its own', () => {
  const target = { id: 'tenant-a', baseUrl: 'http://127.0.0.1:1', route: 'sweego' as const };

  function reporterWith(sent: string[][]): DroppedOutcomes {
    return createDroppedOutcomes({
      client: {
        reportOutcomes: async (_target, outcomes) => {
          sent.push(outcomes.map((o) => o.id));
          return { recorded: outcomes.map((o) => o.id), alreadyHandled: [], unknown: [] };
        },
      },
      log: createLogger(() => {}),
    });
  }

  it('sends at most 200 outcomes in a request', async () => {
    const sent: string[][] = [];
    const reporter = reporterWith(sent);
    for (let n = 0; n < 450; n += 1) {
      reporter.dropped('tenant-a', `m-${n}`, 1);
    }
    reporter.acked({
      acked: Array.from({ length: 450 }, (_, n) => `m-${n}`),
      alreadyHandled: [],
      unknown: [],
    });
    await reporter.flush(target);
    expect(sent.map((batch) => batch.length)).toEqual([200, 200, 50]);
  });

  it('is bounded: past a thousand waiting reports the oldest is given up', () => {
    const reporter = reporterWith([]);
    for (let n = 0; n < 1001; n += 1) {
      reporter.dropped('tenant-a', `m-${n}`, 1);
    }
    expect(reporter.pending).toBe(1000);
  });

  it('treats an id the spool already handled as reportable', async () => {
    const sent: string[][] = [];
    const reporter = reporterWith(sent);
    reporter.dropped('tenant-a', 'm-1', 1);
    reporter.acked({ acked: [], alreadyHandled: ['m-1'], unknown: [] });
    await reporter.flush(target);
    expect(sent).toEqual([['m-1']]);
  });

  it('reports a spool only its own messages', async () => {
    const sent: string[][] = [];
    const reporter = reporterWith(sent);
    reporter.dropped('tenant-b', 'm-1', 1);
    reporter.acked({ acked: ['m-1'], alreadyHandled: [], unknown: [] });
    await reporter.flush(target);
    expect(sent).toEqual([]);
    expect(reporter.pending).toBe(1);
  });
});
