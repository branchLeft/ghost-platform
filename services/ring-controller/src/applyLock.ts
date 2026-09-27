/**
 * Enforces "bumps within a ring are serial, so at most one tenant is ever
 * in `applying`" (LLD-4 §04, load-bearing) as a structural guard beneath
 * the ring's own serial iteration -- so a scheduling bug that fired two
 * bumps at once still could not put two tenants in the uninterruptible
 * migration step together.
 *
 * Same queued-promise shape as services/broker's own `asyncMutex.ts`:
 * every `run` call chains onto whichever call is already in flight, and
 * the tail is reset to a settled (never-rejecting) promise so one
 * caller's failure can never wedge the queue for callers behind it, while
 * still propagating to *that* caller.
 */
export interface ApplyLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createApplyLock(): ApplyLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(fn, fn);
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
}
