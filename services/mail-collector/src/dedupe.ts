/**
 * Named `submitted`, not `delivered` -- LLD-6 M5 (load-bearing, per the
 * review this responds to): "delivered must come from mx1's delivery
 * outcome, not the submission hop... otherwise a tenant's delivery rate is
 * a submission rate and silent bounces never surface." What this tracker
 * actually knows, the moment it records something, is that mx1's SMTP
 * front accepted the DATA command for that message -- nothing about
 * whether mx1 went on to relay it, or whether it bounced afterwards. The
 * shim's own `ackDrain` doc comment (`services/mailgun-shim/src/store.ts`)
 * draws the identical line for the same reason: "an ack means the drainer
 * took responsibility for the message, not that anyone received it."
 * Relaying mx1's real delivery outcome back through this pipeline is a
 * separately planned mechanism, deliberately out of this service's own
 * scope: this tracker records submission to mx1, never delivery.
 */
export interface SubmittedTracker {
  has(id: string): boolean;
  markSubmitted(id: string): void;
  /** Drops entries older than the configured TTL. Called on a timer by the caller, not internally, so tests can drive it deterministically. */
  sweep(): void;
  readonly size: number;
}

/**
 * What turns the shim's documented at-least-once drain (routes/drain.ts: a
 * lease that lapses before an ack is re-offered "to this drainer again or
 * to another one") into exactly-once SUBMISSION at mx1. A message id is
 * stable across re-offers (the shim's own contract), so remembering which
 * ids this process has already handed to mx1 is enough: a re-offer caused
 * by a lost ack is recognised here and skipped, not resubmitted -- only
 * re-acked, to finally clear it from the shim's queue.
 *
 * Bounded by a TTL rather than kept forever, so a long-running process does
 * not accumulate one entry per message ever sent. The TTL only needs to
 * outlast the window in which a re-offer of the SAME id can plausibly still
 * arrive (bounded by the shim's lease length plus however long an ack can
 * stay lost); the default in config.ts is an hour, comfortably past that.
 */
export function createSubmittedTracker(
  ttlMs: number,
  now: () => number = Date.now
): SubmittedTracker {
  const submittedAt = new Map<string, number>();

  return {
    has(id: string): boolean {
      return submittedAt.has(id);
    },
    markSubmitted(id: string): void {
      submittedAt.set(id, now());
    },
    sweep(): void {
      const cutoff = now() - ttlMs;
      for (const [id, at] of submittedAt) {
        if (at < cutoff) {
          submittedAt.delete(id);
        }
      }
    },
    get size(): number {
      return submittedAt.size;
    },
  };
}
