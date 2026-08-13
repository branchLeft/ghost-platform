import type { Throttle } from '../../src/throttle.js';

/** A Throttle stand-in that never blocks — for tests exercising the queue/worker where throttling isn't under test. */
export function createUnlimitedThrottle(): Throttle {
  return {
    tryTake: () => true,
    reload: () => {
      // nothing to reload
    },
    currentRate: () => Number.POSITIVE_INFINITY,
  };
}
