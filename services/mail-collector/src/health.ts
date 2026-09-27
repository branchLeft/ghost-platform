/**
 * Whether the estate's dead-man's switch should keep hearing from this
 * process. Deliberately minimal -- a single consecutive-submission-failure
 * counter, not the per-class oldest-undrained-age metric LLD-8 §10b's
 * cross-document review also names for "the first drain worker" (that one
 * needs a design decision on what a "class" is here that this story does
 * not make; filed separately rather than built speculatively).
 *
 * What this DOES cover, named explicitly by the review this responds to: a
 * collector that cannot submit anything to mx1 -- wrong credential, mx1
 * down, every connection refused -- must not keep paging "healthy" forever
 * just because its own liveness loop is still running. `recordFailure` is
 * called only on a delivery (SMTP submission) failure, never on a drain
 * fetch failure against one host among several -- one unreachable spool
 * among many healthy ones is not "the collector is stuck", and conflating
 * the two would suppress the heartbeat over a single host's routine outage.
 */
export interface HealthState {
  recordSuccess(): void;
  recordFailure(): void;
  readonly consecutiveFailures: number;
  isHealthy(threshold: number): boolean;
}

export function createHealthState(): HealthState {
  let consecutiveFailures = 0;
  return {
    recordSuccess(): void {
      consecutiveFailures = 0;
    },
    recordFailure(): void {
      consecutiveFailures += 1;
    },
    get consecutiveFailures(): number {
      return consecutiveFailures;
    },
    isHealthy(threshold: number): boolean {
      return consecutiveFailures < threshold;
    },
  };
}
