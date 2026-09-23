export interface GhostProbe {
  isHealthy(): Promise<boolean>;
}

// What the TLS-terminating edge sets on every real request. A tenant
// configured with an https site URL redirects any request it doesn't
// consider secure to that https URL; without this header a plain loopback
// probe gets redirected onto a port with no TLS listener, reads as a
// connection failure, and the slot looks permanently unhealthy even though
// Ghost answered fine.
const FORWARDED_PROTO_HEADERS = { 'X-Forwarded-Proto': 'https' };

/**
 * Ghost carries no readiness route of its own, so "healthy" here is nothing
 * more than the ordinary front page answering exactly 200 -- never any other
 * 2xx, and never a 3xx read on trust, because a redirect can point anywhere,
 * including at a host this process was never asked to trust. `redirect:
 * 'manual'` stops fetch from ever leaving this origin on our behalf; a
 * redirect then just fails the `=== 200` check like any other wrong status,
 * rather than being followed. A non-200 status, a connection failure and a
 * timeout are all folded into the same false -- this probe never rejects,
 * because its one caller has nothing useful to do with a distinction
 * between "Ghost said no" and "Ghost didn't say".
 */
export function createHttpGhostProbe(url: string, timeoutMs: number): GhostProbe {
  return {
    async isHealthy() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: FORWARDED_PROTO_HEADERS,
          redirect: 'manual',
        });
        const healthy = response.status === 200;
        // Never read -- only the status matters here -- but an unconsumed
        // body keeps the underlying connection from being released back to
        // the pool. Best-effort and fire-and-forget: the health verdict is
        // already decided, and an unhandled rejection here must not be
        // allowed to take the process down over a cleanup step.
        /* v8 ignore next 3 -- no deterministic way to make cancel() itself reject */
        response.body?.cancel().catch(() => {
          return undefined;
        });
        return healthy;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
