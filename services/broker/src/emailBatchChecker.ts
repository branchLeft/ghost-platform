import type { SlotName } from '@branchleft/ghost-platform-render-core';

/**
 * LLD-4 §U5, load-bearing: blue is not stopped while it holds an email or
 * batch in `submitting` -- Ghost promotes an orphaned `submitting` batch to
 * `failed` rather than resending it, so stopping a colour mid-send costs a
 * reader a partial newsletter.
 *
 * Deliberately a seam rather than a concrete query against Ghost's own
 * database, for the same reason `AdminApiClient` is one (`adminApi.ts`'s
 * own doc comment): no design document specifies how the broker reaches
 * Ghost's `email_batches` table without becoming a second privileged path
 * alongside the sudoers wrapper (LLD-2 §02 treats that boundary as
 * something to extend deliberately, not by inference) -- the demo host's
 * colour pair shares one Docker-managed volume the broker's own uid does
 * not own, and this story does not decide how a read-only line item is
 * granted. What this story owns is that `/stop` calls it, before the
 * traffic-counter check's own decision is acted on, and refuses exactly
 * when it reports `true`.
 */
export interface EmailBatchChecker {
  hasSubmittingBatch(slot: SlotName): Promise<boolean>;
}

/**
 * The safe default when no real implementation is configured
 * (`BROKER_EMAIL_BATCH_CHECKER_MODULE` unset): reports a submitting batch
 * unconditionally, so `/stop` always refuses rather than admit a guess.
 * Wiring a real one -- the DB access decision named above -- is an owner
 * action; see the PR body's runbook section.
 */
export function createFailClosedEmailBatchChecker(): EmailBatchChecker {
  return {
    async hasSubmittingBatch() {
      return true;
    },
  };
}
