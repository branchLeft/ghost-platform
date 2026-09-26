import type { Logger } from './log.js';

export interface HeartbeatOptions {
  url: string;
  intervalMs: number;
  log: Logger;
  fetchImpl?: typeof fetch;
}

export interface Heartbeat {
  stop(): void;
}

/**
 * Pings the estate's dead-man's switch on its own timer,
 * independent of whether this process is draining anything right now --
 * the switch has a heartbeat to miss only if an idle collector keeps
 * pinging it. Started once at process boot and never gated on drain
 * activity; a ping failure is logged and the timer keeps running rather
 * than stopping the switch's only signal because one HTTP call failed.
 */
export function startHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const doFetch = opts.fetchImpl ?? fetch;
  let stopped = false;

  function tick(): void {
    if (stopped) {
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
