import { decodeOutcomeMessageId } from './outcomeId.js';
import { readDsn, toOutcome } from './dsn.js';
import { normaliseAuthservId } from './mailHeaders.js';
import type { DsnMailbox } from './dsnMailbox.js';
import type { ComplainedReport, OutcomeClient, OutcomeReport } from './drainClient.js';
import type { ArfReader } from './arf/arfReader.js';
import type { TargetStore } from './descriptorTargets.js';
import type { Logger } from './log.js';

export interface OutcomeRunner {
  /** One pass over the mailbox. Never throws: a failure is logged and the notification stays for the next pass. */
  runOnce(): Promise<{ reported: number; retired: number; left: number }>;
}

export interface OutcomeRunnerDeps {
  mailbox: DsnMailbox;
  store: TargetStore;
  drainClient: OutcomeClient;
  log: Logger;
  /**
   * The authserv-id our own receiving MTA stamps in its Authentication-Results
   * header. A notification is read only when exactly one such header is
   * present, so a bounce a stranger mailed to the return path is ignored and
   * retired, never reported. Required: there is no unauthenticated mode.
   */
  trustedAuthservId: string;
  /**
   * How long a notice the spool calls `unknown` is kept and retried before
   * it is retired as unplaceable. `unknown` is usually a race (the notice
   * beat the ack, or the spool has not caught up), so it must not be lost;
   * but a stale generation never resolves, so it cannot be kept forever.
   */
  unknownGraceMs?: number;
  /**
   * Off unless given. With a reader, a feedback-loop report in the same
   * directory is read before the DSN parser and reported as `complained`; a
   * report that is not trustworthy is retired with its reason, never reported.
   * Give it only once the spool accepts a complained outcome: a report it
   * cannot parse fails the whole batch. See ./arf/README.md.
   */
  complaintReader?: ArfReader;
  now?: () => number;
}

const DEFAULT_UNKNOWN_GRACE_MS = 60 * 60 * 1000;

/**
 * Carries mx1's per-message outcome back to the spool that handed the
 * message over, over the same drain connection (POST /drain/outcomes). A
 * notification is retired only after the spool has answered for it, so a
 * dead spool or a restart loses nothing; one that carries no outcome
 * (relayed, expanded, unrecognised) is retired without being reported,
 * since it can never become one.
 * See ../README.md#outcomes-carried-back-to-the-spool.
 */
export function createOutcomeRunner(deps: OutcomeRunnerDeps): OutcomeRunner {
  const trustedAuthservId = normaliseAuthservId(deps.trustedAuthservId);
  const unknownGraceMs = deps.unknownGraceMs ?? DEFAULT_UNKNOWN_GRACE_MS;
  const now = deps.now ?? Date.now;
  async function runOnce(): Promise<{ reported: number; retired: number; left: number }> {
    let reported = 0;
    let retired = 0;
    let left = 0;

    let items;
    try {
      items = await deps.mailbox.list();
    } catch (error) {
      deps.log.warn('outcome_mailbox_failed', { error: (error as Error).message });
      return { reported, retired, left };
    }

    const byTarget = new Map<
      string,
      Array<{ ref: string; receivedAtMs: number; report: OutcomeReport | ComplainedReport }>
    >();
    const retire = async (ref: string): Promise<void> => {
      try {
        await deps.mailbox.markProcessed(ref);
        retired += 1;
      } catch (error) {
        left += 1;
        deps.log.warn('outcome_retire_failed', { ref, error: (error as Error).message });
      }
    };

    for (const item of items) {
      if (deps.complaintReader) {
        const arf = deps.complaintReader(item.raw, item.receivedAtMs);
        if (arf.ok) {
          const { record } = arf;
          const list = byTarget.get(record.targetId) ?? [];
          list.push({
            ref: item.ref,
            receivedAtMs: item.receivedAtMs,
            report: { id: record.id, drainCount: record.drainCount, outcome: 'complained' },
          });
          byTarget.set(record.targetId, list);
          continue;
        }
        if (arf.reason !== 'not_arf') {
          // Never a DSN and never a complaint: kept in processed/ for audit, never guessed at.
          deps.log.info('complaint_rejected', { ref: item.ref, reason: arf.reason });
          await retire(item.ref);
          continue;
        }
      }
      const read = readDsn(item.raw, trustedAuthservId);
      const dsn = read.ok ? read.dsn : null;
      const key = dsn ? decodeOutcomeMessageId(dsn.originalMessageId) : null;
      const outcome = dsn ? toOutcome(dsn) : null;
      if (!dsn || !key || !outcome) {
        deps.log.info('outcome_ignored', {
          ref: item.ref,
          reason: !read.ok ? read.reason : !key ? 'not_ours' : 'no_final_outcome',
        });
        await retire(item.ref);
        continue;
      }
      const list = byTarget.get(key.targetId) ?? [];
      list.push({
        ref: item.ref,
        receivedAtMs: item.receivedAtMs,
        report: { id: key.id, drainCount: key.drainCount, ...outcome },
      });
      byTarget.set(key.targetId, list);
    }

    for (const [targetId, entries] of byTarget) {
      const target = deps.store.targets.find((t) => t.id === targetId);
      if (!target) {
        // The spool is no longer in the descriptor: do not guess an address for it.
        left += entries.length;
        deps.log.warn('outcome_target_unknown', { target: targetId, count: entries.length });
        continue;
      }
      let result;
      try {
        result = await deps.drainClient.reportOutcomes(
          target,
          entries.map((e) => e.report)
        );
        reported += result.recorded.length;
        deps.log.info('outcomes_reported', {
          target: targetId,
          recorded: result.recorded.length,
          alreadyHandled: result.alreadyHandled.length,
          unknown: result.unknown.length,
        });
      } catch (error) {
        left += entries.length;
        deps.log.warn('outcome_report_failed', {
          target: targetId,
          error: (error as Error).message,
        });
        continue;
      }
      const unknownIds = new Set(result.unknown);
      for (const entry of entries) {
        if (unknownIds.has(entry.report.id) && now() - entry.receivedAtMs < unknownGraceMs) {
          // The spool does not know this generation yet: most likely the
          // notice beat the ack. Keep it; the next pass asks again.
          left += 1;
          deps.log.info('outcome_unknown_kept', { target: targetId, message: entry.report.id });
          continue;
        }
        await retire(entry.ref);
      }
    }

    return { reported, retired, left };
  }

  return { runOnce };
}
