import type { Logger } from '../log.js';
import type { OutcomeResult } from '../drainClient.js';
import { decodeOutcomeMessageId } from '../outcomeId.js';
import { journalKey, type CursorStore, type JournalEntry, type OutcomeJournal } from './journal.js';
import {
  reportKindFor,
  step,
  toReport,
  type Observation,
  type SweegoReport,
} from './stateMachine.js';

/** One record read from the provider's sending logs. */
export interface ProviderRecord {
  /** The correlation value as the provider recorded it (our own header); null when the record has none. */
  outcomeId: string | null;
  observation: Observation;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Day-granular, offset-paged: the shape the Sweego log listing offers. */
export interface ListQuery {
  fromDate: string;
  toDate: string;
  offset: number;
  size: number;
}

export interface OutcomeProvider {
  list(query: ListQuery, signal?: AbortSignal): Promise<ProviderRecord[]>;
}

/** The existing hand-over to a spool, addressed by target id; the caller resolves the target from the descriptor. */
export interface OutcomeSink {
  report(targetId: string, reports: SweegoReport[]): Promise<OutcomeResult>;
}

export interface PollerOptions {
  /** Days of sending logs the plan retains. No default: it is a contract fact. */
  retentionDays: number;
  pageSize?: number;
  maxPages?: number;
  /** After this long without a final word a message is `expired`. */
  expiryMs?: number;
  /** A poll gap of this fraction of retention or more is flagged at risk. */
  atRiskFraction?: number;
  /** How long a settled entry stays so a late complaint can still be placed. */
  closedKeepMs?: number;
  /** Off until the spool accepts a complained outcome: a report it cannot parse would fail the whole batch. */
  reportComplaints?: boolean;
}

export interface PollSummary {
  /** Every page of the window was read without error. */
  complete: boolean;
  records: number;
  applied: number;
  reported: number;
  /** Records without one of our correlation values, or naming no journal entry. */
  foreign: number;
  /** Records whose value names a different spool than the journal's. */
  mismatched: number;
  /** Undelivered records the provider did not classify; never acted on. */
  unclassified: number;
  expired: number;
  lostToRetention: number;
  /** The gap since the last complete scan reached the at-risk fraction of retention. */
  atRisk: boolean;
  /** Milliseconds from the last complete scan to the start of this pass, null before the first. */
  gapMs: number | null;
}

export interface OutcomePoller {
  /** One pass. Never throws: a failure leaves state as it was and the next pass retries. */
  runOnce(): Promise<PollSummary>;
}

export interface OutcomePollerDeps {
  provider: OutcomeProvider;
  journal: OutcomeJournal;
  cursor: CursorStore;
  sink: OutcomeSink;
  log: Logger;
  options: PollerOptions;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_BATCH = 200;

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function windowOpen(entry: JournalEntry): boolean {
  return (
    entry.state === 'submitted' || entry.state === 'deferred' || entry.state === 'bounced-soft'
  );
}

export function createOutcomePoller(deps: OutcomePollerDeps): OutcomePoller {
  const { provider, journal, cursor, sink, log } = deps;
  const now = deps.now ?? Date.now;
  const opts = {
    pageSize: deps.options.pageSize ?? 500,
    maxPages: deps.options.maxPages ?? 40,
    expiryMs: deps.options.expiryMs ?? 72 * 60 * 60 * 1000,
    atRiskFraction: deps.options.atRiskFraction ?? 0.5,
    closedKeepMs: deps.options.closedKeepMs ?? 7 * DAY_MS,
    reportComplaints: deps.options.reportComplaints ?? false,
    retentionDays: deps.options.retentionDays,
  };
  if (!Number.isInteger(opts.retentionDays) || opts.retentionDays < 1) {
    throw new Error('retentionDays must be a positive integer');
  }

  /** Reads every page of the window; null when any page failed, so a partial read is never applied as a whole. */
  async function readWindow(fromDate: string, toDate: string): Promise<ProviderRecord[] | null> {
    const all: ProviderRecord[] = [];
    try {
      for (let page = 0; page < opts.maxPages; page += 1) {
        const rows = await provider.list({
          fromDate,
          toDate,
          offset: page * opts.pageSize,
          size: opts.pageSize,
        });
        all.push(...rows);
        if (rows.length < opts.pageSize) {
          return all;
        }
      }
    } catch (error) {
      // Only the error's name: a provider error may quote a request.
      log.warn('sweego_outcome_poll_failed', { error: (error as Error).name });
      return null;
    }
    log.warn('sweego_outcome_poll_page_budget', { maxPages: opts.maxPages });
    return null;
  }

  async function runOnce(): Promise<PollSummary> {
    const at = now();
    const summary: PollSummary = {
      complete: false,
      records: 0,
      applied: 0,
      reported: 0,
      foreign: 0,
      mismatched: 0,
      unclassified: 0,
      expired: 0,
      lostToRetention: 0,
      atRisk: false,
      gapMs: null,
    };
    const previousScan = cursor.read().lastCompleteScanMs;
    summary.gapMs = previousScan === null ? null : at - previousScan;
    summary.atRisk =
      summary.gapMs !== null && summary.gapMs >= opts.atRiskFraction * opts.retentionDays * DAY_MS;

    // 1. Retention: a message older than the oldest day the provider still
    // holds can no longer be read; say so rather than scan for it forever.
    const floorDate = utcDate(at - (opts.retentionDays - 1) * DAY_MS);
    for (const entry of journal.list()) {
      if (windowOpen(entry) && utcDate(entry.submittedAtMs) < floorDate) {
        journal.put({
          ...entry,
          state: step(entry.state, { kind: 'timeout' }),
          lostToRetention: true,
          updatedAtMs: at,
        });
        summary.lostToRetention += 1;
      }
    }

    // 2. Read the window from the oldest message still waiting.
    const waiting = journal.list().filter(windowOpen);
    let records: ProviderRecord[] | null = [];
    if (waiting.length > 0) {
      const from = waiting.reduce(
        (min, e) => Math.min(min, e.submittedAtMs),
        Number.MAX_SAFE_INTEGER
      );
      records = await readWindow(utcDate(from), utcDate(at));
    }
    summary.complete = records !== null;
    if (records !== null) {
      summary.records = records.length;
      records.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
      for (const record of records) {
        const key = record.outcomeId ? decodeOutcomeMessageId(record.outcomeId) : null;
        const entry = key ? journal.get(journalKey(key)) : undefined;
        if (!key || !entry) {
          summary.foreign += 1;
          continue;
        }
        if (entry.targetId !== key.targetId) {
          summary.mismatched += 1;
          continue;
        }
        const obs = record.observation;
        if (obs.kind === 'undelivered' && obs.bounce === null) {
          summary.unclassified += 1;
          continue;
        }
        const next = step(entry.state, obs);
        if (next === entry.state) {
          continue;
        }
        journal.put({
          ...entry,
          state: next,
          detail:
            obs.kind === 'undelivered' ? { code: obs.code, message: obs.message } : entry.detail,
          updatedAtMs: at,
        });
        summary.applied += 1;
      }
      cursor.write({ lastCompleteScanMs: at });
    }

    // 3. The clock closes what is still silent.
    for (const entry of journal.list()) {
      if (windowOpen(entry) && at - entry.submittedAtMs > opts.expiryMs) {
        journal.put({
          ...entry,
          state: step(entry.state, { kind: 'timeout' }),
          updatedAtMs: at,
        });
        summary.expired += 1;
      }
    }

    // 4. Hand owed reports to the spool, one target at a time.
    const owed = new Map<string, Array<{ entry: JournalEntry; report: SweegoReport }>>();
    for (const entry of journal.list()) {
      const kind = reportKindFor(entry.state);
      if (kind === null || kind === entry.reported) {
        continue;
      }
      if (kind === 'complained' && !opts.reportComplaints) {
        continue;
      }
      const report = toReport(entry, entry.state, entry.detail);
      if (report) {
        const list = owed.get(entry.targetId) ?? [];
        list.push({ entry, report });
        owed.set(entry.targetId, list);
      }
    }
    for (const [targetId, items] of owed) {
      for (let i = 0; i < items.length; i += REPORT_BATCH) {
        const chunk = items.slice(i, i + REPORT_BATCH);
        let result: OutcomeResult;
        try {
          result = await sink.report(
            targetId,
            chunk.map((c) => c.report)
          );
        } catch (error) {
          log.warn('sweego_outcome_report_failed', {
            target: targetId,
            error: (error as Error).name,
          });
          break;
        }
        const answered = new Set([...result.recorded, ...result.alreadyHandled]);
        for (const { entry } of chunk) {
          if (!answered.has(entry.id)) {
            continue;
          }
          journal.put({ ...entry, reported: reportKindFor(entry.state) });
          summary.reported += 1;
        }
      }
    }

    // 5. Forget what is settled and old.
    for (const entry of journal.list()) {
      const owes = reportKindFor(entry.state);
      const settled = !windowOpen(entry) && (owes === null || owes === entry.reported);
      const stale = at - entry.updatedAtMs > opts.closedKeepMs;
      const beyond = at - entry.submittedAtMs > opts.retentionDays * DAY_MS + opts.closedKeepMs;
      if ((settled && stale) || beyond) {
        journal.remove(journalKey(entry));
      }
    }
    return summary;
  }

  return { runOnce };
}
