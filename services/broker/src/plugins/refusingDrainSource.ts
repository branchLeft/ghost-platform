/**
 * The `DrainSource` seam (`../drainSource.ts`), filled with a deliberate,
 * permanent refusal: nothing is ever handed over through `GET /drain`.
 * See refusingDrainSource.md#refusingdrainsource.
 */
import type { DrainSource } from '../drainSource.js';
import type { SeamMarker } from '../seamReadiness.js';

export const DRAIN_REFUSAL =
  'mail is collected from the mail queue directly; nothing is handed over here';

const drainSource: DrainSource & SeamMarker = {
  real: true,
  poll() {
    return Promise.reject(new Error(DRAIN_REFUSAL));
  },
};

export default drainSource;
