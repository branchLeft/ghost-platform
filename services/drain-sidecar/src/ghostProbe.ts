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
 * more than the ordinary front page answering 200 -- exactly 200, never any
 * other 2xx or 3xx, because a redirect followed to nowhere is not the same
 * as Ghost being well. A non-200 status, a connection failure and a timeout
 * are all folded into the same false -- this probe never rejects, because
 * its one caller has nothing useful to do with a distinction between
 * "Ghost said no" and "Ghost didn't say".
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
        });
        return response.status === 200;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
