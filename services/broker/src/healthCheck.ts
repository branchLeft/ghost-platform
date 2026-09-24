export interface HealthChecker {
  isHealthy(healthPort: number): Promise<boolean>;
}

/**
 * Mirrors `services/drain-sidecar/src/ghostProbe.ts`'s own posture: a
 * non-200, a connection failure and a timeout are all just "not healthy" --
 * `/status` has nothing useful to do with a finer distinction, and folding
 * them together means a slow or unreachable sidecar reads as unhealthy
 * rather than throwing out of the handler.
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
