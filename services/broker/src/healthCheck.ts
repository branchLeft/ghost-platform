/**
 * Mirrors `demo-host/provision/health_router.py`'s `COLOUR_HEADER` and
 * `EDGE_ADDR`: the router rejects a check unless this header carries
 * `127.0.0.1:<colour app port>` exactly. See healthCheck.md#colour-header.
 */
export const COLOUR_HEADER = 'X-Colour-Upstream';
export const COLOUR_UPSTREAM_ADDR = '127.0.0.1';

export interface HealthChecker {
  /**
   * Whether the colour whose app listens on `colourAppPort` is healthy,
   * asked at the slot's one `healthPort`.
   */
  isHealthy(healthPort: number, colourAppPort: number): Promise<boolean>;
}

/**
 * A non-200, a connection failure and a timeout are all just "not healthy":
 * `/status` has nothing useful to do with a finer distinction, and folding
 * them together means a slow or unreachable router reads as unhealthy
 * rather than throwing out of the handler. The health port is shared by
 * both colours, so the check names the colour it means in the same header
 * the edge sends, and the slot's health router answers for that colour
 * alone. See healthCheck.md#createhttphealthchecker.
 */
export function createHttpHealthChecker(host: string, timeoutMs: number): HealthChecker {
  return {
    async isHealthy(healthPort, colourAppPort) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`http://${host}:${healthPort}/healthz`, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { [COLOUR_HEADER]: `${COLOUR_UPSTREAM_ADDR}:${colourAppPort}` },
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
