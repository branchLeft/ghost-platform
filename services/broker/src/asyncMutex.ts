/**
 * A host-wide, in-process async mutex: every call to `run` is queued behind
 * whichever call is already in flight, by chaining onto one shared promise.
 * `.then(fn, fn)` runs `fn` whether the previous link resolved or rejected,
 * so one caller's failure never wedges the queue for callers after it, and
 * the tail is reset to a settled (never-rejecting) promise so a rejection
 * from `fn` propagates to *this* caller without becoming an unhandled
 * rejection on the shared chain.
 */
export interface AsyncMutex {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createAsyncMutex(): AsyncMutex {
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
