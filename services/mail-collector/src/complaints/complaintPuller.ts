import type { OutcomeClient } from '../drainClient.js';
import type { TargetStore } from '../descriptorTargets.js';
import type { Logger } from '../log.js';
import type { SentJournal } from '../sentJournal.js';
import type { QueuedComplaint, ReceiverClient } from './receiverClient.js';

export interface ComplaintPullerOptions {
  /** Wait between passes when the last one went through cleanly. */
  pollMs: number;
  /** First wait after a failed pass; doubles on each failure in a row. */
  retryBackoffMs: number;
  maxBackoffMs: number;
  /** Most complaints reported to one tenant's spool in any rolling hour; the rest are dropped, counted and alerted. */
  perTenantPerHour: number;
  /**
   * A complaint that cannot be reported for this long after the receiver got it
   * (its spool is gone from the descriptor, or never opted in) is given up on, so
   * one dead spool cannot hold the receiver's queue for ever.
   */
  giveUpMs: number;
}

export interface ComplaintCounts {
  pulled: number;
  reported: number;
  /** Named an id the journal does not hold: never sent by us. Dropped. */
  unmatched: number;
  /** A repeat of an outcome id already reported. Dropped. */
  duplicates: number;
  /** Over the tenant's hourly cap. Dropped. */
  capped: number;
  /** The spool did not know the message. Dropped. */
  unknown: number;
  abandoned: number;
  pullFailures: number;
  reportFailures: number;
  ackFailures: number;
}

export interface PassSummary {
  /** Records read this pass. */
  pulled: number;
  /** The highest sequence acknowledged to the receiver this pass, null if none. */
  ackedThrough: number | null;
  /** Any of pull, report or ack failed. */
  failed: boolean;
  /** How long the caller waits before the next pass. */
  nextDelayMs: number;
}

export interface ComplaintPuller {
  /** One pass. Never throws: a failure leaves the receiver's queue untouched and the next pass retries. */
  runOnce(): Promise<PassSummary>;
  counts(): Readonly<ComplaintCounts>;
}

export interface ComplaintPullerDeps {
  receiver: ReceiverClient;
  journal: Pick<SentJournal, 'lookup'>;
  store: Pick<TargetStore, 'targets'>;
  outcomes: Pick<OutcomeClient, 'reportOutcomes'>;
  log: Logger;
  options: ComplaintPullerOptions;
  now?: () => number;
}

/** The receiver's own page limit. */
export const PULL_LIMIT = 500;
/** The spool refuses more than this many outcomes in one request. */
const REPORT_BATCH = 200;
const HOUR_MS = 60 * 60 * 1000;
const REMEMBERED_REPORTED = 10_000;

interface Item {
  complaint: QueuedComplaint;
  id: string;
  drainCount: number;
}

/**
 * Pulls the Sweego complaint receiver's queue and carries each complaint to
 * the spool of the tenant whose message it names. See
 * ../../README.md#sweego-complaints-pulled-from-the-receiver.
 *
 * A complaint is placed only through the sent-id journal: an outcome id we
 * never sent is dropped, and the spool it is reported to is the journal's, not
 * anything the complaint says. The receiver is acknowledged only through the
 * last complaint of an unbroken run that has been handled (reported, or
 * dropped for a stated reason); a complaint whose report failed is not
 * acknowledged and neither is anything after it, so it is pulled again. A
 * complaint after it that was handled is remembered, so the retry does not
 * report it twice or count it twice.
 */
export function createComplaintPuller(deps: ComplaintPullerDeps): ComplaintPuller {
  const { receiver, journal, store, outcomes, log, options } = deps;
  const now = deps.now ?? Date.now;
  const counts: ComplaintCounts = {
    pulled: 0,
    reported: 0,
    unmatched: 0,
    duplicates: 0,
    capped: 0,
    unknown: 0,
    abandoned: 0,
    pullFailures: 0,
    reportFailures: 0,
    ackFailures: 0,
  };
  // Sequences handled but not yet acknowledged to the receiver.
  const settled = new Set<number>();
  const reportedIds = new Set<string>();
  // Report times per spool inside the rolling hour.
  const windows = new Map<string, number[]>();
  const alerted = new Set<string>();
  let consecutiveFailures = 0;

  function backoffMs(): number {
    const grown = options.retryBackoffMs * 2 ** Math.max(0, consecutiveFailures - 1);
    return Math.min(options.maxBackoffMs, grown);
  }

  function windowFor(targetId: string, at: number): number[] {
    const kept = (windows.get(targetId) ?? []).filter((t) => at - t < HOUR_MS);
    windows.set(targetId, kept);
    if (kept.length === 0) {
      alerted.delete(targetId);
    }
    return kept;
  }

  function remember(outcomeId: string): void {
    reportedIds.add(outcomeId);
    if (reportedIds.size > REMEMBERED_REPORTED) {
      const oldest = reportedIds.values().next().value;
      if (oldest !== undefined) {
        reportedIds.delete(oldest);
      }
    }
  }

  async function runOnce(): Promise<PassSummary> {
    const at = now();
    let failed = false;
    let records: QueuedComplaint[];
    try {
      records = await receiver.pull(PULL_LIMIT);
    } catch (error) {
      counts.pullFailures += 1;
      consecutiveFailures += 1;
      log.warn('complaint_pull_failed', { error: (error as Error).message });
      return { pulled: 0, ackedThrough: null, failed: true, nextDelayMs: backoffMs() };
    }
    records.sort((a, b) => a.seq - b.seq);
    counts.pulled += records.length;

    /** A complaint that could not be reported yet: kept for the next pass, or given up on once it is too old. */
    function retryOrAbandon(complaint: QueuedComplaint, reason: string): void {
      if (at - complaint.at * 1000 >= options.giveUpMs) {
        counts.abandoned += 1;
        settled.add(complaint.seq);
        log.warn('complaint_abandoned', { seq: complaint.seq, reason });
      }
    }

    const byTarget = new Map<string, Item[]>();
    const seenThisPass = new Set<string>();
    for (const complaint of records) {
      if (settled.has(complaint.seq)) {
        continue;
      }
      const entry = journal.lookup(complaint.outcomeId);
      if (!entry) {
        // Never sent by us: a forgery, a stray, or a message past the journal's memory.
        counts.unmatched += 1;
        settled.add(complaint.seq);
        log.info('complaint_unmatched', { seq: complaint.seq });
        continue;
      }
      if (reportedIds.has(complaint.outcomeId) || seenThisPass.has(complaint.outcomeId)) {
        counts.duplicates += 1;
        settled.add(complaint.seq);
        continue;
      }
      seenThisPass.add(complaint.outcomeId);
      if (!store.targets.some((t) => t.id === entry.targetId)) {
        // The spool left the descriptor: no address is guessed for it.
        log.warn('complaint_target_unknown', { target: entry.targetId, seq: complaint.seq });
        retryOrAbandon(complaint, 'target_unknown');
        continue;
      }
      const list = byTarget.get(entry.targetId) ?? [];
      list.push({ complaint, id: entry.id, drainCount: entry.drainCount });
      byTarget.set(entry.targetId, list);
    }

    for (const [targetId, items] of byTarget) {
      const target = store.targets.find((t) => t.id === targetId);
      if (!target) {
        continue;
      }
      const window = windowFor(targetId, at);
      const room = Math.max(0, options.perTenantPerHour - window.length);
      const admitted = items.slice(0, room);
      const overflow = items.slice(room);
      if (overflow.length > 0) {
        counts.capped += overflow.length;
        for (const item of overflow) {
          settled.add(item.complaint.seq);
        }
        if (!alerted.has(targetId)) {
          alerted.add(targetId);
          log.warn('complaint_cap_reached', {
            target: targetId,
            cap: options.perTenantPerHour,
            dropped: overflow.length,
          });
        }
      }
      for (let from = 0; from < admitted.length; from += REPORT_BATCH) {
        const chunk = admitted.slice(from, from + REPORT_BATCH);
        let result;
        try {
          result = await outcomes.reportOutcomes(
            target,
            chunk.map((c) => ({
              id: c.id,
              drainCount: c.drainCount,
              outcome: 'complained' as const,
            }))
          );
        } catch (error) {
          failed = true;
          counts.reportFailures += 1;
          log.warn('complaint_report_failed', {
            target: targetId,
            count: chunk.length,
            error: (error as Error).message,
          });
          for (const item of chunk) {
            retryOrAbandon(item.complaint, 'report_failed');
          }
          // The rest of this spool's chunks would meet the same answer.
          break;
        }
        const done = new Set([...result.recorded, ...result.alreadyHandled]);
        const unknown = new Set(result.unknown);
        for (const item of chunk) {
          if (done.has(item.id)) {
            counts.reported += 1;
            window.push(at);
            remember(item.complaint.outcomeId);
            settled.add(item.complaint.seq);
          } else if (unknown.has(item.id)) {
            // A complaint arrives long after the send and its ack: the spool will not learn this one later.
            counts.unknown += 1;
            settled.add(item.complaint.seq);
            log.warn('complaint_spool_unknown', { target: targetId, message: item.id });
          } else {
            retryOrAbandon(item.complaint, 'not_answered');
          }
        }
      }
    }

    // Acknowledge only the unbroken run of handled complaints from the front.
    let through: number | null = null;
    for (const complaint of records) {
      if (!settled.has(complaint.seq)) {
        break;
      }
      through = complaint.seq;
    }
    let ackedThrough: number | null = null;
    if (through !== null) {
      try {
        await receiver.ack(through);
        ackedThrough = through;
        for (const seq of settled) {
          if (seq <= through) {
            settled.delete(seq);
          }
        }
      } catch (error) {
        failed = true;
        counts.ackFailures += 1;
        log.warn('complaint_ack_failed', { error: (error as Error).message });
      }
    }

    if (failed) {
      consecutiveFailures += 1;
      return { pulled: records.length, ackedThrough, failed, nextDelayMs: backoffMs() };
    }
    consecutiveFailures = 0;
    // A full page that was acknowledged means there may be more behind it.
    const more = records.length >= PULL_LIMIT && ackedThrough !== null;
    return {
      pulled: records.length,
      ackedThrough,
      failed,
      nextDelayMs: more ? 0 : options.pollMs,
    };
  }

  return {
    runOnce,
    counts: () => ({ ...counts }),
  };
}
