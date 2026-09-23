/**
 * Wakes a held `GET /drain` request the instant something is enqueued,
 * rather than making it wait out its own poll interval. Without this, "a
 * message enqueued ... is handed over on a waiting drain request within a
 * second of enqueue" (the story's Done sentence) would only be true by
 * coincidence of the poll interval chosen; with it, the wait is bounded by
 * how fast this process can run a query, not by a timer.
 *
 * Deliberately not a queue of payloads — a waiter that wakes re-queries the
 * store itself (claimForDrain), so a wake is a pure "something might be
 * available now" signal, never a delivery mechanism in its own right. That
 * keeps this module tiny and keeps the store as the single source of truth
 * for what is actually claimable, which matters once #1236's inbound SMTP
 * front door also calls notify() after its own enqueue.
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
