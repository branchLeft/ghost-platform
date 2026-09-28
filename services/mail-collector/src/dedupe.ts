/**
 * Named `submitted`, not `delivered` -- LLD-6 M5: this tracker records
 * that mx1's SMTP front accepted the message, never that mx1 relayed or
 * it was actually delivered. See ../README.md#dedupe-submittedtracker.
 */
export interface SubmittedTracker {
  has(id: string): boolean;
  markSubmitted(id: string): void;
  /** Drops entries older than the configured TTL. Called on a timer by the caller, not internally, so tests can drive it deterministically. */
  sweep(): void;
  readonly size: number;
}

/**
 * Turns the shim's at-least-once drain into exactly-once submission at
 * mx1: a re-offer of an already-handed-off id is skipped, only re-acked.
 * Bounded by a TTL long enough to outlast a plausible re-offer window.
 * See ../README.md#dedupe-createsubmittedtracker.
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
