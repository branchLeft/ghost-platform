export interface GhostProbe {
  isHealthy(baseUrl: string): Promise<boolean>;
}

// What the TLS-terminating edge sets on every real request -- carried here
// too even though this colour is never routed, because the tenant's own
// Ghost `url` config is https (LLD-4 §U3b) and a plain loopback probe with
// no header gets redirected onto a port nothing is listening on TLS for.
// Mirrors services/drain-sidecar/src/ghostProbe.ts's own reasoning; not
// imported from it for the same not-published reason drainFlag.ts gives.
const FORWARDED_PROTO_HEADERS = { 'X-Forwarded-Proto': 'https' };

/**
 * The admin API's public site route, not the home page: the export colour
 * has no outbound route, and rendering the home page makes Ghost probe the
 * size of every remote image it references, each waiting out a connection
 * that can never complete. This route renders no remote content, and the
 * admin API is all the export uses.
 */
export const HEALTH_PATH = '/ghost/api/admin/site/';

export function createHttpGhostProbe(timeoutMs: number): GhostProbe {
  return {
    async isHealthy(baseUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(new URL(HEALTH_PATH, baseUrl), {
          signal: controller.signal,
          headers: FORWARDED_PROTO_HEADERS,
          redirect: 'manual',
        });
        const healthy = response.status === 200;
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

/** Polls until healthy or the deadline passes -- never rejects on timeout. */
export async function waitUntilHealthy(
  probe: GhostProbe,
  baseUrl: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probe.isHealthy(baseUrl)) return true;
    await sleep(pollIntervalMs);
  } while (Date.now() < deadline);
  return false;
}
