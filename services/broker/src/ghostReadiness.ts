export interface GhostReadinessChecker {
  /** `port` is always one colour's own app port (`slotPorts.ts`'s `slotPort`), never the
   * slot's shared health port -- unlike the sidecar's health port, a colour's app port is
   * never ambiguous between colours, so this needs no router to answer for a single one. */
  isReady(port: number): Promise<boolean>;
}

// Mirrors `services/drain-sidecar/src/ghostProbe.ts`'s contract exactly, rather than
// importing it: that package answers for whichever single Ghost its own env points at, with
// no port argument, while the broker asks the same question of a specific colour's port
// during a swap. Two independent callers of Ghost's own front page, not two designs for it.
const FORWARDED_PROTO_HEADERS = { 'X-Forwarded-Proto': 'https' };

/**
 * "Verify by calling it directly" (LLD-4 §U3b) -- a colour's own front page answering
 * exactly 200, never a 3xx read on trust (a redirect can point anywhere) and never any other
 * 2xx. Folds a non-200, a connection failure and a timeout into the same false: the swap
 * sequence that calls this has nothing useful to do with the difference between "Ghost said
 * no" and "Ghost didn't say" -- either way this colour is not yet safe to route to, or not yet
 * safe to let the other one stop covering for.
 */
export function createHttpGhostReadinessChecker(
  host: string,
  timeoutMs: number
): GhostReadinessChecker {
  return {
    async isReady(port) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`http://${host}:${port}/`, {
          signal: controller.signal,
          headers: FORWARDED_PROTO_HEADERS,
          redirect: 'manual',
        });
        const ready = response.status === 200;
        response.body?.cancel().catch(() => undefined);
        return ready;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Polls `checker` until it answers ready or `deadlineMs` passes, rather than asking once --
 * Ghost's own maintenance mode answers 503 for a couple of seconds after
 * boot even on a fresh, otherwise-healthy container, so a single call here would make every
 * swap racy against Ghost's own boot time. Returns `false` on a timeout rather than throwing:
 * the caller (`app.ts`) decides what a colour that never became ready means for the slot, and
 * a boolean keeps this function's own job to exactly one thing -- polling -- rather than also
 * picking the error the swap should report.
 */
export async function waitUntilReady(
  checker: GhostReadinessChecker,
  port: number,
  deadlineMs: number,
  pollIntervalMs = 200,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await checker.isReady(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
}
