/**
 * Wakes a held GET /drain the moment something is enqueued. A wake is only
 * a signal: the waiter re-queries the store, the single source of truth.
 * See drainWake.md#drainwake.
 */
export interface DrainWake {
  /** Resolves on the next notify() (or the given timeout, whichever comes first) — never rejects. */
  waitForSignal(timeoutMs: number): Promise<void>;
  /** Wakes every currently-waiting waitForSignal() call. Safe to call with nothing waiting. */
  notify(): void;
}

export function createDrainWake(): DrainWake {
  let waiters: Array<() => void> = [];

  return {
    waitForSignal(timeoutMs: number): Promise<void> {
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          waiters = waiters.filter((w) => w !== wake);
          resolve();
        }, timeoutMs);
        // Node's setTimeout keeps the event loop alive by default — a
        // still-open long poll must never be the reason the process can't
        // exit on SIGTERM (server.ts's own shutdown path closes the HTTP
        // server first, but a bare `node dist/server.js` under a test
        // harness with no explicit close should still be able to exit).
        timer.unref?.();

        function wake(): void {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        }

        waiters.push(wake);
      });
    },

    notify(): void {
      const toWake = waiters;
      waiters = [];
      for (const wake of toWake) {
        wake();
      }
    },
  };
}
