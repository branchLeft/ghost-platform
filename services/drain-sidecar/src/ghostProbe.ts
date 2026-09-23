export interface GhostProbe {
  isHealthy(): Promise<boolean>;
}

/**
 * Ghost carries no readiness route of its own, so "healthy" here is nothing
 * more than the ordinary front page answering 200. A non-200 status, a
 * connection failure and a timeout are all folded into the same false --
 * this probe never rejects, because its one caller has nothing useful to do
 * with a distinction between "Ghost said no" and "Ghost didn't say".
 */
export function createHttpGhostProbe(url: string, timeoutMs: number): GhostProbe {
  return {
    async isHealthy() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        return response.status === 200;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
