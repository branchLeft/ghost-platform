import type { DrainTarget } from './descriptorTargets.js';
import type { AckResult, OutcomeClient, OutcomeReport } from './drainClient.js';
import type { Logger } from './log.js';

/**
 * Tells the spool that a recipient Sweego refused for good has failed. The
 * message is acked at once and never retried, so Ghost would otherwise show it
 * as accepted and the address would not be suppressed. The report is the
 * spool's existing outcome route (a permanent failure on an acked message), so
 * it can only follow the ack, and only reaches a spool that opted in. See
 * ../README.md#a-dropped-recipient-reported-back-to-the-spool.
 */
export interface DroppedOutcomes {
  /** A message was dropped; its report waits for the ack. */
  dropped(targetId: string, id: string, drainCount: number): void;
  /** The spool offered the message again: its generation moved, so the report must carry the new one. */
  offered(id: string, drainCount: number): void;
  /** An ack went through: the dropped messages it covers can now be reported. */
  acked(result: AckResult): void;
  /** Reports what is due for this spool. Never throws: a failure is logged and tried again later. */
  flush(target: DrainTarget): Promise<void>;
  /** Reports still waiting, for tests and signals. */
  readonly pending: number;
}

export interface DroppedOutcomesOptions {
  client: OutcomeClient;
  log: Logger;
  now?: () => number;
  /** How long to wait before telling the spool again after a failure or an `unknown`. */
  retryMs?: number;
  /** How long a report is kept before it is given up on (the spool never opted in, or lost the message). */
  giveUpMs?: number;
}

const DEFAULT_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 1000;
// The spool refuses more than this many outcomes in one request.
const MAX_PER_REQUEST = 200;

/** The text the spool stores and Ghost shows: it names no address and no subject. */
const FAILURE_TEXT = 'Recipient refused by the delivery relay';

interface Entry {
  targetId: string;
  drainCount: number;
  since: number;
  nextTryAt: number;
  acked: boolean;
}

export function createDroppedOutcomes(options: DroppedOutcomesOptions): DroppedOutcomes {
  const { client, log } = options;
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const giveUpMs = options.giveUpMs ?? DEFAULT_GIVE_UP_MS;
  const entries = new Map<string, Entry>();

  function abandon(id: string, entry: Entry): void {
    entries.delete(id);
    log.warn('dropped_outcome_abandoned', { target: entry.targetId, message: id });
  }

  return {
    dropped(targetId, id, drainCount) {
      if (entries.size >= MAX_PENDING && !entries.has(id)) {
        const oldest = entries.entries().next().value;
        if (oldest) {
          abandon(oldest[0], oldest[1]);
        }
      }
      entries.set(id, { targetId, drainCount, since: now(), nextTryAt: 0, acked: false });
    },
    offered(id, drainCount) {
      const entry = entries.get(id);
      if (entry) {
        entry.drainCount = drainCount;
      }
    },
    acked(result) {
      for (const id of [...result.acked, ...result.alreadyHandled]) {
        const entry = entries.get(id);
        if (entry) {
          entry.acked = true;
        }
      }
    },
    async flush(target) {
      const at = now();
      const due: Array<[string, Entry]> = [];
      for (const [id, entry] of entries) {
        if (at - entry.since >= giveUpMs) {
          abandon(id, entry);
        } else if (entry.targetId === target.id && entry.acked && at >= entry.nextTryAt) {
          due.push([id, entry]);
        }
      }
      for (let from = 0; from < due.length; from += MAX_PER_REQUEST) {
        const batch = due.slice(from, from + MAX_PER_REQUEST);
        const reports: OutcomeReport[] = batch.map(([id, entry]) => ({
          id,
          drainCount: entry.drainCount,
          outcome: 'failed',
          severity: 'permanent',
          message: FAILURE_TEXT,
        }));
        let result;
        try {
          result = await client.reportOutcomes(target, reports);
        } catch (error) {
          for (const [, entry] of batch) {
            entry.nextTryAt = at + retryMs;
          }
          log.warn('dropped_outcome_report_failed', {
            target: target.id,
            count: batch.length,
            error: (error as Error).message,
          });
          continue;
        }
        const unknown = new Set(result.unknown);
        for (const [id, entry] of batch) {
          if (unknown.has(id)) {
            entry.nextTryAt = at + retryMs;
          } else {
            entries.delete(id);
          }
        }
        log.info('dropped_outcomes_reported', {
          target: target.id,
          recorded: result.recorded.length,
          alreadyHandled: result.alreadyHandled.length,
          unknown: result.unknown.length,
        });
      }
    },
    get pending(): number {
      return entries.size;
    },
  };
}
