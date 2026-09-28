export interface GhostProbe {
  isHealthy(): Promise<boolean>;
}

// What the TLS-terminating edge sets on every real request. A tenant
// configured with an https site URL redirects any request it doesn't
// consider secure to that https URL; without this header a plain loopback
// probe gets redirected onto a port with no TLS listener, reads as a
// connection failure, and the slot looks permanently unhealthy even though
// Ghost answered fine.
export const FORWARDED_PROTO_HEADERS = { 'X-Forwarded-Proto': 'https' };

/**
 * "Healthy" is the ordinary front page answering exactly 200; never rejects.
 * See ../README.md#what-healthy-means-to-the-ghost-probe.
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
        // already decided, and cancel() can reject (a body that errors mid-
        // stream, e.g. the connection resetting after headers arrive) --
        // that must not become an unhandled rejection that takes the whole
        // process down over a cleanup step.
        response.body?.cancel().catch(() => undefined);
        return healthy;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
