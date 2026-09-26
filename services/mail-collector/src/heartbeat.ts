import type { Logger } from './log.js';

export interface HeartbeatOptions {
  url: string;
  intervalMs: number;
  log: Logger;
  fetchImpl?: typeof fetch;
  /**
   * Checked on every tick before pinging. Defaults to always-true, which
   * is the plain liveness behaviour ("pings while idle as well as while
   * working"). A caller that wires this to something reflecting actual
   * progress (src/health.ts) is what stops a wedged collector -- every
   * submission failing, nothing else changing -- from paging "healthy"
   * forever; see collectorLoop.ts's own wiring and the PR body's review
   * response for why a bare liveness ping alone was found insufficient.
   */
  shouldPing?: () => boolean;
}

export interface Heartbeat {
  stop(): void;
}

/**
 * Pings the estate's dead-man's switch on its own timer,
 * independent of whether this process is draining anything right now --
 * the switch has a heartbeat to miss only if an idle collector keeps
 * pinging it. Started once at process boot and never gated on drain
 * activity by default; a ping failure is logged and the timer keeps
 * running rather than stopping the switch's only signal because one HTTP
 * call failed. `shouldPing`, when it returns false, skips only the fetch
 * for that tick -- the timer itself never stops, so pinging resumes the
 * moment the caller's own signal recovers.
 */
export function startHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const doFetch = opts.fetchImpl ?? fetch;
  const shouldPing = opts.shouldPing ?? (() => true);
  let stopped = false;

  function tick(): void {
    if (stopped) {
      return;
    }
    if (!shouldPing()) {
      opts.log.warn('heartbeat_suppressed', {});
      timer = setTimeout(tick, opts.intervalMs);
      timer.unref?.();
      return;
    }
    doFetch(opts.url, { method: 'GET' })
      .then((res) => {
        if (!res.ok) {
          opts.log.warn('heartbeat_rejected', { status: res.status });
        }
      })
      .catch((error: unknown) => {
        opts.log.warn('heartbeat_failed', { error: (error as Error).message });
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, opts.intervalMs);
          timer.unref?.();
        }
      });
  }

  let timer: ReturnType<typeof setTimeout>;
  tick();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
