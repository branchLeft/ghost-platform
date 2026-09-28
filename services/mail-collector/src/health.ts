/**
 * Whether the estate's dead-man's switch should keep hearing from this
 * process. `recordFailure` fires only on a delivery (SMTP submission)
 * failure, never on a single host's drain-fetch failure.
 * See ../README.md#health-healthstate.
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
