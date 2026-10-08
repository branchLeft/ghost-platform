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
}

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

    const byTarget = new Map<string, Array<{ ref: string; report: OutcomeReport }>>();
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
      list.push({ ref: item.ref, report: { id: key.id, drainCount: key.drainCount, ...outcome } });
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
      try {
        const result = await deps.drainClient.reportOutcomes(
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
      for (const entry of entries) {
        await retire(entry.ref);
      }
    }

    return { reported, retired, left };
  }

  return { runOnce };
}
