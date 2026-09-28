import type { DrainFlag } from './drainFlag.js';

/**
 * LLD-8 §08b's control case: an export triggered while the colour is
 * undrained must be refused, not silently run against a live site.
 * See ../README.md#the-drained-colour-control.
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
