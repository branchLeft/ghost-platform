import { beforeEach, describe, expect, it } from 'vitest';
import {
  createComplaintPuller,
  type ComplaintPuller,
  type ComplaintPullerOptions,
} from '../../src/complaints/complaintPuller.js';
import type { QueuedComplaint, ReceiverClient } from '../../src/complaints/receiverClient.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import type { OutcomeClient, OutcomeResult } from '../../src/drainClient.js';
import { createLogger } from '../../src/log.js';
import { createSentJournal, type SentJournal } from '../../src/sentJournal.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const SECRET = 'SECRET_TOKEN_VALUE_FOR_TEST';

const TARGET_A: DrainTarget = { id: 'tenant-a', baseUrl: 'http://a.invalid', route: 'sweego' };
const TARGET_B: DrainTarget = { id: 'tenant-b', baseUrl: 'http://b.invalid', route: 'sweego' };

interface Harness {
  puller: ComplaintPuller;
  journal: SentJournal;
  /** Everything that happened, in order: `report:<ids>` and `ack:<through>`. */
  events: string[];
  reports: Array<{ targetId: string; outcomes: unknown[] }>;
  queue: QueuedComplaint[];
  clock: { now: number };
  mode: {
    pullFails: boolean;
    ackFails: boolean;
    /** Spool ids whose report throws. */
    reportFailsFor: Set<string>;
    unknownFor: Set<string>;
  };
  lines: string[];
  targets: ReturnType<typeof createFakeTargetStore>;
}

function build(options: Partial<ComplaintPullerOptions> = {}): Harness {
  const events: string[] = [];
  const reports: Harness['reports'] = [];
  const lines: string[] = [];
  const clock = { now: NOW };
  const queue: QueuedComplaint[] = [];
  const mode: Harness['mode'] = {
    pullFails: false,
    ackFails: false,
    reportFailsFor: new Set(),
    unknownFor: new Set(),
  };
  const journal = createSentJournal({ ttlMs: 35 * 24 * HOUR, now: () => clock.now });
  const targets = createFakeTargetStore([TARGET_A, TARGET_B]);
  const receiver: ReceiverClient = {
    async pull() {
      if (mode.pullFails) {
        throw new Error('receiver down');
      }
      return queue.map((r) => ({ ...r }));
    },
    async ack(through) {
      if (mode.ackFails) {
        throw new Error('ack down');
      }
      events.push(`ack:${through}`);
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]!.seq <= through) {
          queue.splice(i, 1);
        }
      }
    },
  };
  const outcomes: Pick<OutcomeClient, 'reportOutcomes'> = {
    async reportOutcomes(target, batch): Promise<OutcomeResult> {
      if (mode.reportFailsFor.has(target.id)) {
        throw new Error('POST /drain/outcomes -> 404');
      }
      const result: OutcomeResult = { recorded: [], alreadyHandled: [], unknown: [] };
      for (const outcome of batch) {
        if (mode.unknownFor.has(outcome.id)) {
          result.unknown.push(outcome.id);
        } else {
          result.recorded.push(outcome.id);
        }
      }
      events.push(`report:${batch.map((o) => o.id).join(',')}`);
      reports.push({ targetId: target.id, outcomes: batch });
      return result;
    },
  };
  const puller = createComplaintPuller({
    receiver,
    journal,
    store: targets,
    outcomes,
    log: createLogger((line) => lines.push(line)),
    options: {
      pollMs: 30_000,
      retryBackoffMs: 1000,
      maxBackoffMs: 8000,
      perTenantPerHour: 3,
      giveUpMs: 24 * HOUR,
      ...options,
    },
    now: () => clock.now,
  });
  return { puller, journal, events, reports, queue, clock, mode, lines, targets };
}

let seqCounter = 0;
function complain(h: Harness, outcomeId: string, ageMs = 0): number {
  seqCounter += 1;
  const seq = seqCounter;
  h.queue.push({ seq, outcomeId, class: 'spam', at: Math.floor((h.clock.now - ageMs) / 1000) });
  return seq;
}

function sent(h: Harness, targetId: string, id: string, drainCount = 1): string {
  h.journal.record({ targetId, id, drainCount, atMs: h.clock.now });
  return `${id}.${drainCount}`;
}

describe('complaint puller', () => {
  let h: Harness;

  beforeEach(() => {
    seqCounter = 0;
    h = build();
  });

  it('reports a complaint for a message we sent to the spool the journal names, then acks it', async () => {
    complain(h, sent(h, 'tenant-a', 'msg-1', 2));
    const summary = await h.puller.runOnce();
    expect(h.reports).toEqual([
      {
        targetId: 'tenant-a',
        outcomes: [{ id: 'msg-1', drainCount: 2, outcome: 'complained' }],
      },
    ]);
    expect(h.events).toEqual(['report:msg-1', 'ack:1']);
    expect(summary).toMatchObject({
      pulled: 1,
      ackedThrough: 1,
      failed: false,
      nextDelayMs: 30_000,
    });
    expect(h.puller.counts().reported).toBe(1);
  });

  it('never reports a complaint for an id we did not send, and counts and drops it', async () => {
    sent(h, 'tenant-a', 'msg-1');
    complain(h, 'never-sent.1');
    const summary = await h.puller.runOnce();
    expect(h.reports).toEqual([]);
    expect(h.puller.counts().unmatched).toBe(1);
    // Dropped means released: the receiver is not left holding a forgery.
    expect(h.events).toEqual(['ack:1']);
    expect(summary.failed).toBe(false);
  });

  it('does not place a complaint by its own claim: an id sent to one tenant never reaches another', async () => {
    complain(h, sent(h, 'tenant-a', 'msg-a'));
    complain(h, sent(h, 'tenant-b', 'msg-b'));
    await h.puller.runOnce();
    expect(h.reports.map((r) => [r.targetId, (r.outcomes[0] as { id: string }).id])).toEqual([
      ['tenant-a', 'msg-a'],
      ['tenant-b', 'msg-b'],
    ]);
  });

  it('does not acknowledge a complaint whose report failed, and delivers it on the next pass', async () => {
    complain(h, sent(h, 'tenant-a', 'msg-1'));
    h.mode.reportFailsFor.add('tenant-a');
    const first = await h.puller.runOnce();
    expect(first.failed).toBe(true);
    expect(first.ackedThrough).toBeNull();
    expect(h.events).toEqual([]);
    expect(h.queue).toHaveLength(1);

    h.mode.reportFailsFor.clear();
    const second = await h.puller.runOnce();
    expect(second.failed).toBe(false);
    expect(h.events).toEqual(['report:msg-1', 'ack:1']);
    expect(h.queue).toHaveLength(0);
  });

  it('acks only up to the complaint before a failed one, and does not report the later ones twice', async () => {
    complain(h, sent(h, 'tenant-b', 'first'));
    complain(h, sent(h, 'tenant-a', 'stuck'));
    complain(h, sent(h, 'tenant-b', 'third'));
    h.mode.reportFailsFor.add('tenant-a');
    await h.puller.runOnce();
    // `first` and `third` were reported (one request, as they share a spool), only `first` is released.
    expect(h.events).toEqual(['report:first,third', 'ack:1']);
    expect(h.queue.map((r) => r.seq)).toEqual([2, 3]);

    h.mode.reportFailsFor.clear();
    await h.puller.runOnce();
    expect(h.events).toEqual(['report:first,third', 'ack:1', 'report:stuck', 'ack:3']);
    expect(h.puller.counts().reported).toBe(3);
  });

  it('keeps a complaint when the ack fails and re-acks without reporting it again', async () => {
    complain(h, sent(h, 'tenant-a', 'msg-1'));
    h.mode.ackFails = true;
    const first = await h.puller.runOnce();
    expect(first.failed).toBe(true);
    expect(h.puller.counts().ackFailures).toBe(1);

    h.mode.ackFails = false;
    await h.puller.runOnce();
    expect(h.reports).toHaveLength(1);
    expect(h.events).toEqual(['report:msg-1', 'ack:1']);
  });

  it('backs off on a pull failure, doubling to a ceiling, and resets after a clean pass', async () => {
    h.mode.pullFails = true;
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      delays.push((await h.puller.runOnce()).nextDelayMs);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(h.puller.counts().pullFailures).toBe(6);

    h.mode.pullFails = false;
    expect((await h.puller.runOnce()).nextDelayMs).toBe(30_000);
    h.mode.pullFails = true;
    expect((await h.puller.runOnce()).nextDelayMs).toBe(1000);
  });

  it('loses nothing while the receiver is down: the queue is untouched until a pass succeeds', async () => {
    complain(h, sent(h, 'tenant-a', 'msg-1'));
    h.mode.pullFails = true;
    await h.puller.runOnce();
    await h.puller.runOnce();
    expect(h.queue).toHaveLength(1);
    h.mode.pullFails = false;
    await h.puller.runOnce();
    expect(h.reports).toHaveLength(1);
  });

  describe('the hourly cap per tenant', () => {
    it('reports up to the cap, drops the rest with a count and one alert, and never touches another tenant', async () => {
      for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
        complain(h, sent(h, 'tenant-a', id));
      }
      complain(h, sent(h, 'tenant-b', 'b1'));
      await h.puller.runOnce();
      const toA = h.reports.filter((r) => r.targetId === 'tenant-a').flatMap((r) => r.outcomes);
      expect(toA).toHaveLength(3);
      expect(h.reports.filter((r) => r.targetId === 'tenant-b')).toHaveLength(1);
      expect(h.puller.counts()).toMatchObject({ reported: 4, capped: 2 });
      const alerts = h.lines.filter((l) => l.includes('complaint_cap_reached'));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('tenant-a');
    });

    it('holds across passes inside the hour and opens again after it', async () => {
      for (const id of ['a1', 'a2', 'a3']) {
        complain(h, sent(h, 'tenant-a', id));
      }
      await h.puller.runOnce();
      complain(h, sent(h, 'tenant-a', 'a4'));
      h.clock.now += HOUR - 1;
      await h.puller.runOnce();
      expect(h.puller.counts()).toMatchObject({ reported: 3, capped: 1 });

      complain(h, sent(h, 'tenant-a', 'a5'));
      h.clock.now += 2;
      await h.puller.runOnce();
      expect(h.puller.counts().reported).toBe(4);
    });

    it('does not spend the cap on a report that failed', async () => {
      for (const id of ['a1', 'a2', 'a3']) {
        complain(h, sent(h, 'tenant-a', id));
      }
      h.mode.reportFailsFor.add('tenant-a');
      await h.puller.runOnce();
      h.mode.reportFailsFor.clear();
      await h.puller.runOnce();
      expect(h.puller.counts()).toMatchObject({ reported: 3, capped: 0 });
    });
  });

  it('drops a repeat of an outcome id once, as the receiver may deliver it twice', async () => {
    const id = sent(h, 'tenant-a', 'msg-1');
    complain(h, id);
    complain(h, id);
    await h.puller.runOnce();
    complain(h, id);
    await h.puller.runOnce();
    expect(h.reports).toHaveLength(1);
    expect(h.puller.counts()).toMatchObject({ reported: 1, duplicates: 2 });
    expect(h.queue).toHaveLength(0);
  });

  it('drops a complaint the spool does not know, and counts it', async () => {
    complain(h, sent(h, 'tenant-a', 'gone'));
    h.mode.unknownFor.add('gone');
    await h.puller.runOnce();
    expect(h.puller.counts()).toMatchObject({ reported: 0, unknown: 1 });
    expect(h.events).toEqual(['report:gone', 'ack:1']);
  });

  it('holds a complaint whose spool left the descriptor, then gives up after the give-up age', async () => {
    complain(h, sent(h, 'tenant-a', 'msg-1'));
    h.targets.setTargets([TARGET_B]);
    const first = await h.puller.runOnce();
    expect(first.ackedThrough).toBeNull();
    expect(h.queue).toHaveLength(1);

    h.clock.now += 25 * HOUR;
    await h.puller.runOnce();
    expect(h.puller.counts().abandoned).toBe(1);
    expect(h.queue).toHaveLength(0);
    expect(h.reports).toEqual([]);
  });

  it('gives up on a spool that never accepts, rather than holding the receiver for ever', async () => {
    complain(h, sent(h, 'tenant-a', 'msg-1'));
    h.mode.reportFailsFor.add('tenant-a');
    await h.puller.runOnce();
    h.clock.now += 25 * HOUR;
    await h.puller.runOnce();
    expect(h.puller.counts().abandoned).toBe(1);
    expect(h.queue).toHaveLength(0);
  });

  it('asks again at once after a full page it acknowledged', async () => {
    for (let i = 0; i < 500; i += 1) {
      complain(h, `never-sent-${i}.1`);
    }
    const summary = await h.puller.runOnce();
    expect(summary.nextDelayMs).toBe(0);
    expect(h.puller.counts().unmatched).toBe(500);
  });

  it('writes no outcome id, token or address into a log line', async () => {
    complain(h, 'forged-value-123.1');
    complain(h, sent(h, 'tenant-a', 'msg-1'));
    h.mode.reportFailsFor.add('tenant-a');
    await h.puller.runOnce();
    const text = h.lines.join('\n');
    expect(text).not.toContain('forged-value-123');
    expect(text).not.toContain(SECRET);
  });
});
