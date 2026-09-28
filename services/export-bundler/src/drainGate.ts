import type { DrainFlag } from './drainFlag.js';

/**
 * LLD-8 §08b's control case: "an export triggered while the colour is
 * undrained (still serving readers) must be refused, not silently run
 * against a live site." LLD-4 §U3b/§U7 generalise the drain flag beyond
 * the bake it was built for -- exactly this use -- but the invariant it
 * protects is unchanged: an offline task never runs against a routed
 * colour, because it can neither be reached by a reader nor compete with
 * one for the same process.
 *
 * This throws rather than returning a boolean so a caller cannot
 * accidentally ignore the verdict -- exportRunner.ts's own sabotage test
 * (removing the call, not just the check inside it) is what proves this
 * function is actually on the path a real export takes, not merely
 * correct in isolation.
 */
export class UndrainedColourError extends Error {
  constructor(colourId: string) {
    super(
      `refusing to export against "${colourId}": its drain flag is not set, so it may be a live colour serving readers`
    );
    this.name = 'UndrainedColourError';
  }
}

export function assertDrained(flag: DrainFlag, colourId: string): void {
  if (!flag.isSet()) {
    throw new UndrainedColourError(colourId);
  }
}
