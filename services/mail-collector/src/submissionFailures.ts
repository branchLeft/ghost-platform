import type { CountedFailureReason } from './sweegoFailure.js';

/**
 * Counts submission failures by reason class, nothing else: no tenant, no
 * message id, no address. The later signals node reads `counts()`.
 */
export interface FailureCounter {
  record(reason: CountedFailureReason): void;
  counts(): Readonly<Partial<Record<CountedFailureReason, number>>>;
}

export function createFailureCounter(): FailureCounter {
  const counts: Partial<Record<CountedFailureReason, number>> = {};
  return {
    record(reason): void {
      counts[reason] = (counts[reason] ?? 0) + 1;
    },
    counts(): Readonly<Partial<Record<CountedFailureReason, number>>> {
      return { ...counts };
    },
  };
}
