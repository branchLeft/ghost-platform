import { decodeOutcomeMessageId } from './outcomeId.js';
import { parseDsn, toOutcome } from './dsn.js';
import type { DsnMailbox } from './dsnMailbox.js';
import type { OutcomeClient, OutcomeReport } from './drainClient.js';
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
   * How long a notice the spool calls `unknown` is kept and retried before
   * it is retired as unplaceable. `unknown` is usually a race (the notice
   * beat the ack, or the spool has not caught up), so it must not be lost;
   * but a stale generation never resolves, so it cannot be kept forever.
   */
  unknownGraceMs?: number;
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
      Array<{ ref: string; receivedAtMs: number; report: OutcomeReport }>
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
      const dsn = parseDsn(item.raw);
      const key = dsn ? decodeOutcomeMessageId(dsn.originalMessageId) : null;
      const outcome = dsn ? toOutcome(dsn) : null;
      if (!dsn || !key || !outcome) {
        deps.log.info('outcome_ignored', {
          ref: item.ref,
          reason: !dsn ? 'not_a_dsn' : !key ? 'not_ours' : 'no_final_outcome',
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
