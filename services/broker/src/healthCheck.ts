export interface HealthChecker {
  isHealthy(healthPort: number): Promise<boolean>;
}

/**
 * Mirrors `services/drain-sidecar/src/ghostProbe.ts`'s own posture: a
 * non-200, a connection failure and a timeout are all just "not healthy" --
 * `/status` has nothing useful to do with a finer distinction, and folding
 * them together means a slow or unreachable sidecar reads as unhealthy
 * rather than throwing out of the handler.
 *
 * LLD-2 §01 gives one health port per slot, shared by both colours, and
 * today's `services/drain-sidecar` answers for whichever single Ghost it
 * was configured against -- it takes no colour parameter, because the
 * router in front of a slot's two colours (the piece that would make
 * "which colour is currently live" answerable at this port at all) is not
 * built. This function calls only the port `app.ts` already derives from
 * the slot, and cannot itself resolve which colour that answer describes
 * until the router exists.
 */
export function createHttpHealthChecker(host: string, timeoutMs: number): HealthChecker {
  return {
    async isHealthy(healthPort) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`http://${host}:${healthPort}/healthz`, {
          signal: controller.signal,
          redirect: 'manual',
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
