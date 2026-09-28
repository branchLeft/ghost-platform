/**
 * Structural guard so at most one tenant is ever in `applying`
 * (LLD-4 §04, load-bearing). See README.md in this directory for the
 * design rationale.
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
