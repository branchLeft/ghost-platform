/**
 * Whether anything answers on Ghost's address at all. See
 * ../README.md#a-ghost-that-restarts-under-it.
 */
export interface ReachabilityProbe {
  isReachable(): Promise<boolean>;
}

/**
 * "Reachable" is any HTTP answer, an error status included: only a refused
 * connection or a timeout says nothing is listening where Ghost used to be.
 * Never rejects.
 */
export function createHttpReachabilityProbe(url: string, timeoutMs: number): ReachabilityProbe {
  return {
    async isReachable() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: 'manual',
        });
        response.body?.cancel().catch(() => undefined);
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface StaleNamespaceWatch {
  /** Probes once; true when Ghost has been unreachable for the whole window. */
  check(): Promise<boolean>;
}

export interface StaleNamespaceWatchOptions {
  probe: ReachabilityProbe;
  staleAfterMs: number;
  now?: () => number;
}

export function createStaleNamespaceWatch(
  options: StaleNamespaceWatchOptions
): StaleNamespaceWatch {
  const now = options.now ?? Date.now;
  let unreachableSince: number | null = null;
  return {
    async check() {
      if (await options.probe.isReachable()) {
        unreachableSince = null;
        return false;
      }
      const at = now();
      unreachableSince ??= at;
      return at - unreachableSince >= options.staleAfterMs;
    },
  };
}

/**
 * Calls `onStale` once, from a timer that never keeps the process alive on
 * its own, when `watch` reports a stale namespace. Returns the stop function.
 */
export function runStaleNamespaceWatch(
  watch: StaleNamespaceWatch,
  intervalMs: number,
  onStale: () => void
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    watch
      .check()
      .then((stale) => {
        if (stale) {
          clearInterval(timer);
          onStale();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
