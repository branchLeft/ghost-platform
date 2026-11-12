import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { writeFileAtomic } from './atomicWrite.js';
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
  /** State-file writes that failed. The queue stays in memory and the failure is logged. */
  readonly stateErrors: number;
}

export interface DroppedOutcomesOptions {
  client: OutcomeClient;
  log: Logger;
  now?: () => number;
  /** How long to wait before telling the spool again after a failure or an `unknown`. */
  retryMs?: number;
  /** How long a report is kept before it is given up on (the spool never opted in, or lost the message). */
  giveUpMs?: number;
  /**
   * File the waiting reports are kept in, so a restart does not lose them.
   * Unset, the queue is memory-only.
   */
  statePath?: string;
}

const DEFAULT_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 1000;
// The spool refuses more than this many outcomes in one request.
const MAX_PER_REQUEST = 200;
const STATE_VERSION = 1;

/** The text the spool stores and Ghost shows: it names no address and no subject. */
const FAILURE_TEXT = 'Recipient refused by the delivery relay';

interface Entry {
  targetId: string;
  drainCount: number;
  since: number;
  nextTryAt: number;
  acked: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Reads the state file back; throws on any shape it does not recognise, so the caller quarantines it. */
function parseState(raw: string): Array<[string, Entry]> {
  const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
  if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.entries)) {
    throw new Error('dropped-outcome state file has an unrecognised shape');
  }
  return parsed.entries.map((row: unknown): [string, Entry] => {
    if (typeof row !== 'object' || row === null) {
      throw new Error('dropped-outcome state file has an unrecognised entry');
    }
    const r = row as Record<string, unknown>;
    if (
      typeof r.id !== 'string' ||
      typeof r.targetId !== 'string' ||
      !isFiniteNumber(r.drainCount) ||
      !isFiniteNumber(r.since) ||
      !isFiniteNumber(r.nextTryAt) ||
      typeof r.acked !== 'boolean'
    ) {
      throw new Error('dropped-outcome state file has an unrecognised entry');
    }
    return [
      r.id,
      {
        targetId: r.targetId,
        drainCount: r.drainCount,
        since: r.since,
        nextTryAt: r.nextTryAt,
        acked: r.acked,
      },
    ];
  });
}

export function createDroppedOutcomes(options: DroppedOutcomesOptions): DroppedOutcomes {
  const { client, log, statePath } = options;
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const giveUpMs = options.giveUpMs ?? DEFAULT_GIVE_UP_MS;
  const entries = new Map<string, Entry>();
  let stateErrors = 0;
  // False once a corrupt file could not be moved aside: writing over it would destroy it.
  let writable = true;

  function persist(): void {
    if (!statePath) {
      return;
    }
    if (!writable) {
      stateErrors += 1;
      log.warn('dropped_outcome_state_failed', { reason: 'corrupt state file not moved aside' });
      return;
    }
    try {
      writeFileAtomic(
        statePath,
        JSON.stringify({
          version: STATE_VERSION,
          entries: [...entries].map(([id, entry]) => ({ id, ...entry })),
        })
      );
    } catch (error) {
      stateErrors += 1;
      log.warn('dropped_outcome_state_failed', { error: (error as Error).message });
    }
  }

  // Moved aside, never deleted, so the bytes can be read after the fact.
  function quarantine(path: string, reason: string): void {
    const aside = `${path}.corrupt-${now()}-${randomUUID().slice(0, 8)}`;
    try {
      renameSync(path, aside);
      log.warn('dropped_outcome_state_quarantined', { file: aside, reason });
    } catch (error) {
      writable = false;
      stateErrors += 1;
      log.warn('dropped_outcome_state_failed', {
        reason,
        error: (error as Error).message,
      });
    }
  }

  function load(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') {
        quarantine(path, `unreadable: ${(error as Error).message}`);
      }
      return;
    }
    try {
      const restored = parseState(raw);
      for (const [id, entry] of restored) {
        entries.set(id, entry);
      }
      log.info('dropped_outcomes_restored', { pending: restored.length });
    } catch (error) {
      quarantine(path, (error as Error).message);
    }
  }

  function abandon(id: string, entry: Entry): void {
    entries.delete(id);
    log.warn('dropped_outcome_abandoned', { target: entry.targetId, message: id });
  }

  if (statePath) {
    load(statePath);
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
      persist();
    },
    offered(id, drainCount) {
      const entry = entries.get(id);
      if (entry) {
        entry.drainCount = drainCount;
        persist();
      }
    },
    acked(result) {
      let changed = false;
      for (const id of [...result.acked, ...result.alreadyHandled]) {
        const entry = entries.get(id);
        if (entry) {
          entry.acked = true;
          changed = true;
        }
      }
      if (changed) {
        persist();
      }
    },
    async flush(target) {
      const at = now();
      const due: Array<[string, Entry]> = [];
      let changed = false;
      for (const [id, entry] of entries) {
        if (at - entry.since >= giveUpMs) {
          abandon(id, entry);
          changed = true;
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
          changed = true;
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
            // Removed only once the spool has answered success for it.
            entries.delete(id);
          }
          changed = true;
        }
        log.info('dropped_outcomes_reported', {
          target: target.id,
          recorded: result.recorded.length,
          alreadyHandled: result.alreadyHandled.length,
          unknown: result.unknown.length,
        });
      }
      if (changed) {
        persist();
      }
    },
    get pending(): number {
      return entries.size;
    },
    get stateErrors(): number {
      return stateErrors;
    },
  };
}
