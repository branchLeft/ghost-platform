import type { StateRecord } from './executePorts.js';

/**
 * Folds the history to what is known to be done: step key to the input digest
 * it completed under. Only a `complete` record counts; a step that was started,
 * failed or refused is not done. The last `complete` for a key wins.
 */
export function completedDigests(records: readonly StateRecord[]): Map<string, string> {
  const done = new Map<string, string>();
  for (const r of records) {
    if (r.event === 'complete' && r.key !== undefined && r.inputDigest !== undefined) {
      done.set(r.key, r.inputDigest);
    }
  }
  return done;
}
