import type { StateRecord } from './executePorts.js';

/**
 * Folds the history to what is known to be done: step key to the input digest
 * it completed under. Only a `complete` or `not-applicable` record counts (a step the register
 * makes not apply is done, and a later run skips it under the same digest); a step that was
 * started, failed or refused is not done. The last such record for a key wins.
 */
export function completedDigests(records: readonly StateRecord[]): Map<string, string> {
  const done = new Map<string, string>();
  for (const r of records) {
    if (
      (r.event === 'complete' || r.event === 'not-applicable') &&
      r.key !== undefined &&
      r.inputDigest !== undefined
    ) {
      done.set(r.key, r.inputDigest);
    }
  }
  return done;
}
