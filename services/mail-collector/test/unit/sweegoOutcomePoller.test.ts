import { beforeEach, describe, expect, it } from 'vitest';
import type { OutcomeResult } from '../../src/drainClient.js';
import { createLogger } from '../../src/log.js';
import { encodeOutcomeMessageId } from '../../src/outcomeId.js';
import {
  createMemoryCursorStore,
  createMemoryJournal,
  journalKey,
  type CursorStore,
  type JournalEntry,
  type OutcomeJournal,
} from '../../src/sweegoOutcomes/journal.js';
import {
  createOutcomePoller,
  type OutcomePoller,
  type OutcomeSink,
  type PollerOptions,
} from '../../src/sweegoOutcomes/poller.js';
import type { Observation, SweegoReport } from '../../src/sweegoOutcomes/stateMachine.js';
import {
  createFakeSweegoProvider,
  type FakeSweegoProvider,
} from '../helpers/fakeSweegoProvider.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const TARGET_A = 'TENANT_A';
const TARGET_B = 'TENANT_B';
const SECRET = 'SECRET_VALUE_FOR_TEST';
const RECIPIENT = 'recipient@example.invalid';

interface Harness {
  provider: FakeSweegoProvider;
  journal: OutcomeJournal;
  cursor: CursorStore;
  reports: Array<{ targetId: string; report: SweegoReport }>;
  lines: string[];
  clock: { now: number };
  sinkMode: { fail: boolean; unknown: Set<string> };
  poller: OutcomePoller;
}

function build(options: Partial<PollerOptions> = {}): Harness {
  const provider = createFakeSweegoProvider();
  const journal = createMemoryJournal();
  const cursor = createMemoryCursorStore();
  const reports: Harness['reports'] = [];
  const lines: string[] = [];
  const clock = { now: NOW };
  const sinkMode = { fail: false, unknown: new Set<string>() };
  const sink: OutcomeSink = {
    async report(targetId, batch): Promise<OutcomeResult> {
      if (sinkMode.fail) {
        throw new Error(`down ${SECRET}`);
      }
      const result: OutcomeResult = { recorded: [], alreadyHandled: [], unknown: [] };
      for (const report of batch) {
        if (sinkMode.unknown.has(report.id)) {
          result.unknown.push(report.id);
        } else {
          reports.push({ targetId, report });
          result.recorded.push(report.id);
        }
      }
      return result;
    },
  };
  const poller = createOutcomePoller({
    provider,
    journal,
    cursor,
    sink,
    log: createLogger((l) => lines.push(l)),
    options: { retentionDays: 14, ...options },
    now: () => clock.now,
  });
  return { provider, journal, cursor, reports, lines, clock, sinkMode, poller };
}

function submit(
  h: Harness,
  id: string,
  targetId = TARGET_A,
  drainCount = 1,
  at = NOW - HOUR
): void {
  const entry: JournalEntry = {
    id,
    drainCount,
    targetId,
    submittedAtMs: at,
    state: 'submitted',
    detail: { code: null, message: null },
    reported: null,
    lostToRetention: false,
    updatedAtMs: at,
  };
  h.journal.put(entry);
}

function record(
  h: Harness,
  id: string,
  observation: Observation,
  opts: { targetId?: string; drainCount?: number; at?: number; updated?: number } = {}
): void {
  h.provider.add({
    outcomeId: encodeOutcomeMessageId({
      id,
      drainCount: opts.drainCount ?? 1,
      targetId: opts.targetId ?? TARGET_A,
    }),
    observation,
    createdAtMs: opts.at ?? NOW - HOUR,
    updatedAtMs: opts.updated ?? NOW - HOUR + 1000,
  });
}

const delivered: Observation = { kind: 'delivered' };
const hardBounce: Observation = { kind: 'undelivered', bounce: 'hard', code: 550, message: 'MSG' };
const softBounce: Observation = { kind: 'undelivered', bounce: 'soft', code: 452, message: 'MSG' };

let h: Harness;
beforeEach(() => {
  h = build();
});

describe('outcome poll: reports to the spool', () => {
  it('reports delivered once, in the existing outcome shape, to the spool the message came from', async () => {
    submit(h, 'M1');
    record(h, 'M1', delivered);
    const summary = await h.poller.runOnce();
    expect(summary.reported).toBe(1);
    expect(h.reports).toEqual([
      { targetId: TARGET_A, report: { id: 'M1', drainCount: 1, outcome: 'delivered' } },
    ]);
  });

  it('is idempotent: the same record read on every pass produces one report', async () => {
    submit(h, 'M1');
    record(h, 'M1', delivered);
    await h.poller.runOnce();
    await h.poller.runOnce();
    await h.poller.runOnce();
    expect(h.reports).toHaveLength(1);
  });

  it('a hard bounce is reported permanent; a soft bounce is reported temporary and a later delivery still lands', async () => {
    submit(h, 'HARD');
    submit(h, 'SOFT');
    record(h, 'HARD', hardBounce);
    record(h, 'SOFT', softBounce);
    await h.poller.runOnce();
    const byId = Object.fromEntries(h.reports.map((r) => [r.report.id, r.report]));
    expect(byId['HARD']).toMatchObject({ outcome: 'failed', severity: 'permanent', code: 550 });
    expect(byId['SOFT']).toMatchObject({ outcome: 'failed', severity: 'temporary' });

    record(h, 'SOFT', delivered, { updated: NOW });
    await h.poller.runOnce();
    expect(h.reports.filter((r) => r.report.id === 'SOFT').map((r) => r.report.outcome)).toEqual([
      'failed',
      'delivered',
    ]);
  });

  it('a soft bounce is never reported permanent, whatever its code says', async () => {
    submit(h, 'M1');
    record(h, 'M1', { kind: 'undelivered', bounce: 'soft', code: 550, message: 'MSG' });
    await h.poller.runOnce();
    expect(h.reports.map((r) => r.report)).toMatchObject([
      { outcome: 'failed', severity: 'temporary' },
    ]);
  });

  it('a bounce the provider did not classify is counted and never reported', async () => {
    submit(h, 'M1');
    record(h, 'M1', { kind: 'undelivered', bounce: null, code: null, message: null });
    const summary = await h.poller.runOnce();
    expect(summary.unclassified).toBe(1);
    expect(h.reports).toEqual([]);
  });

  it('keeps a report the spool answered unknown for, and does not mark it reported', async () => {
    submit(h, 'M1');
    record(h, 'M1', delivered);
    h.sinkMode.unknown.add('M1');
    await h.poller.runOnce();
    expect(h.journal.get(journalKey({ id: 'M1', drainCount: 1 }))?.reported).toBeNull();
    h.sinkMode.unknown.clear();
    await h.poller.runOnce();
    expect(h.reports).toHaveLength(1);
  });

  it('keeps everything when the spool is unreachable and retries on the next pass', async () => {
    submit(h, 'M1');
    record(h, 'M1', delivered);
    h.sinkMode.fail = true;
    await h.poller.runOnce();
    expect(h.reports).toEqual([]);
    h.sinkMode.fail = false;
    await h.poller.runOnce();
    expect(h.reports).toHaveLength(1);
  });
});

describe('outcome poll: complaints', () => {
  // M2 stays open so each pass reads the window; M1 is already delivered.
  it('holds a complaint back until the spool is known to accept one', async () => {
    submit(h, 'M1');
    submit(h, 'M2');
    record(h, 'M1', delivered);
    await h.poller.runOnce();
    record(h, 'M1', { kind: 'complaint' }, { updated: NOW });
    await h.poller.runOnce();
    expect(h.journal.get(journalKey({ id: 'M1', drainCount: 1 }))?.state).toBe('complained');
    expect(h.reports.map((r) => r.report.outcome)).toEqual(['delivered']);
  });

  it('reports a complaint after delivery when enabled, once', async () => {
    h = build({ reportComplaints: true });
    submit(h, 'M1');
    submit(h, 'M2');
    record(h, 'M1', delivered);
    await h.poller.runOnce();
    record(h, 'M1', { kind: 'complaint' }, { updated: NOW });
    await h.poller.runOnce();
    await h.poller.runOnce();
    expect(h.reports.map((r) => r.report.outcome)).toEqual(['delivered', 'complained']);
  });
});

describe('outcome poll: tenant isolation', () => {
  it('never reports a record to a spool other than the one the journal names', async () => {
    submit(h, 'M1', TARGET_A);
    record(h, 'M1', delivered, { targetId: TARGET_B });
    const summary = await h.poller.runOnce();
    expect(summary.mismatched).toBe(1);
    expect(h.reports).toEqual([]);
  });

  it('ignores records that are not ours, or name no journal entry', async () => {
    submit(h, 'M1');
    h.provider.add({
      outcomeId: null,
      observation: delivered,
      createdAtMs: NOW - HOUR,
      updatedAtMs: NOW,
    });
    record(h, 'OTHER', delivered);
    const summary = await h.poller.runOnce();
    expect(summary.foreign).toBe(2);
    expect(h.reports).toEqual([]);
  });

  it('keeps two tenants outcomes separate in one pass', async () => {
    submit(h, 'A1', TARGET_A);
    submit(h, 'B1', TARGET_B);
    record(h, 'A1', delivered, { targetId: TARGET_A });
    record(h, 'B1', hardBounce, { targetId: TARGET_B });
    await h.poller.runOnce();
    expect(h.reports.find((r) => r.report.id === 'A1')?.targetId).toBe(TARGET_A);
    expect(h.reports.find((r) => r.report.id === 'B1')?.targetId).toBe(TARGET_B);
  });
});

describe('outcome poll: cursor, window and gap', () => {
  it('reads from the day of the oldest message still waiting', async () => {
    submit(h, 'OLD', TARGET_A, 1, NOW - 3 * DAY);
    submit(h, 'NEW', TARGET_A, 1, NOW - HOUR);
    await h.poller.runOnce();
    expect(h.provider.queries[0]).toMatchObject({ fromDate: '2026-11-09', toDate: '2026-11-12' });
  });

  it('records a complete scan and does not advance the cursor when a page fails', async () => {
    submit(h, 'M1');
    await h.poller.runOnce();
    expect(h.cursor.read().lastCompleteScanMs).toBe(NOW);
    h.clock.now = NOW + HOUR;
    h.provider.failNext(new Error(`boom ${SECRET}`));
    const summary = await h.poller.runOnce();
    expect(summary.complete).toBe(false);
    expect(h.cursor.read().lastCompleteScanMs).toBe(NOW);
    expect(summary.gapMs).toBe(HOUR);
  });

  it('applies nothing from a window it could not read in full', async () => {
    h = build({ pageSize: 1 });
    submit(h, 'M1');
    submit(h, 'M2');
    record(h, 'M1', delivered);
    record(h, 'M2', delivered);
    // Page one is full, page two fails: neither record may be applied as if the window were whole.
    let calls = 0;
    const original = h.provider.list.bind(h.provider);
    h.provider.list = async (q) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('page two');
      }
      return original(q);
    };
    const summary = await h.poller.runOnce();
    expect(summary.complete).toBe(false);
    expect(h.reports).toEqual([]);
  });

  it('pages through a window larger than one page', async () => {
    h = build({ pageSize: 2 });
    for (const id of ['M1', 'M2', 'M3']) {
      submit(h, id);
      record(h, id, delivered);
    }
    const summary = await h.poller.runOnce();
    expect(summary.records).toBe(3);
    expect(h.reports).toHaveLength(3);
  });

  it('treats a window that exceeds the page budget as incomplete rather than silently partial', async () => {
    h = build({ pageSize: 1, maxPages: 2 });
    for (const id of ['M1', 'M2', 'M3']) {
      submit(h, id);
      record(h, id, delivered);
    }
    const summary = await h.poller.runOnce();
    expect(summary.complete).toBe(false);
    expect(h.reports).toEqual([]);
  });

  it('marks a message lost, not delivered, when it is older than the provider retains', async () => {
    submit(h, 'LOST', TARGET_A, 1, NOW - 20 * DAY);
    const summary = await h.poller.runOnce();
    expect(summary.lostToRetention).toBe(1);
    const entry = h.journal.get(journalKey({ id: 'LOST', drainCount: 1 }));
    expect(entry?.state).toBe('expired');
    expect(entry?.lostToRetention).toBe(true);
    expect(h.reports).toEqual([]);
    // The window never reaches back past what the provider holds.
    expect(h.provider.queries.every((q) => q.fromDate >= '2026-10-30')).toBe(true);
  });

  it('flags a poll gap of half the retention or more as at risk, and a shorter one not', async () => {
    submit(h, 'M1');
    h.cursor.write({ lastCompleteScanMs: NOW - 6 * DAY });
    expect((await h.poller.runOnce()).atRisk).toBe(false);
    h.cursor.write({ lastCompleteScanMs: NOW - 7 * DAY });
    const summary = await h.poller.runOnce();
    expect(summary.atRisk).toBe(true);
    expect(summary.gapMs).toBe(7 * DAY);
  });
});

describe('outcome poll: expiry', () => {
  it('expires a silent message after the expiry window and reports nothing to the spool', async () => {
    submit(h, 'SILENT', TARGET_A, 1, NOW - 73 * HOUR);
    const summary = await h.poller.runOnce();
    expect(summary.expired).toBe(1);
    expect(h.journal.get(journalKey({ id: 'SILENT', drainCount: 1 }))?.state).toBe('expired');
    expect(h.reports).toEqual([]);
  });

  it('lets a late final word replace expired while the message is still inside the window', async () => {
    submit(h, 'LATE', TARGET_A, 1, NOW - 73 * HOUR);
    submit(h, 'OPEN', TARGET_A, 1, NOW - 4 * DAY);
    record(h, 'LATE', delivered, { at: NOW - 73 * HOUR });
    // One pass: the record is applied before the clock closes the message.
    await h.poller.runOnce();
    expect(h.reports.map((r) => r.report.id)).toEqual(['LATE']);
    expect(h.journal.get(journalKey({ id: 'LATE', drainCount: 1 }))?.state).toBe('delivered');
  });
});

describe('outcome poll: nothing sensitive in the logs', () => {
  it('logs no credential, address or provider text when the provider or the spool fails', async () => {
    submit(h, 'M1');
    record(h, 'M1', delivered);
    h.provider.failNext(new Error(`fail ${SECRET} ${RECIPIENT}`));
    await h.poller.runOnce();
    h.sinkMode.fail = true;
    await h.poller.runOnce();
    const logged = h.lines.join('\n');
    expect(logged).toContain('sweego_outcome_poll_failed');
    expect(logged).toContain('sweego_outcome_report_failed');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(RECIPIENT);
  });
});

describe('outcome poll: settled entries', () => {
  it('forgets a settled entry after the keep window and not before', async () => {
    submit(h, 'M1');
    record(h, 'M1', delivered);
    await h.poller.runOnce();
    expect(h.journal.list()).toHaveLength(1);
    h.clock.now = NOW + 8 * DAY;
    await h.poller.runOnce();
    expect(h.journal.list()).toHaveLength(0);
  });
});
