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

export function createHttpGhostProbe(timeoutMs: number): GhostProbe {
  return {
    async isHealthy(baseUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(baseUrl, {
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
