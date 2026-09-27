import type { Logger } from './log.js';

export interface DeadMansSwitchOptions {
  url: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  /**
   * Checked on every `onCycleComplete()` call before pinging. Defaults to
   * always-true. A caller that wires this to something reflecting actual
   * submission progress (src/health.ts) is what stops a collector that
   * completes cycles but cannot submit anything -- every delivery
   * rejected, mx1 down -- from paging "healthy" forever just because its
   * loop is still turning over; see collectorLoop.ts's own wiring.
   */
  shouldPing?: () => boolean;
}

export interface DeadMansSwitch {
  /**
   * Call once per completed poll cycle -- drained-and-delivered or
   * drained-nothing, it does not matter which. Never called on this
   * module's own timer, deliberately: a timer independent of the caller's
   * loop keeps firing exactly while that loop is wedged (blocked on an
   * unresolved fetch, a held socket, anything that never returns), and a
   * ping driven by anything other than the loop's own forward progress
   * would report that a stuck worker is alive. This is the mechanism
   * behind LLD-8 §03b's dead-man's-switch requirement and its load-bearing
   * mark: *silence and failure must look identical, never silence looking
   * like health.*
   */
  onCycleComplete(): void;
}

/**
 * The estate's shared dead-man's-switch client -- pings Healthchecks.io (or
 * the local instance standing in for it in proof) once per caller-reported
 * poll cycle, never on an interval of its own. An idle worker that keeps
 * completing empty cycles keeps pinging, so the switch stays up (LLD-8
 * §10b's control case, load-bearing: *an idle worker with nothing to drain
 * must not page*); a worker whose loop stops progressing -- crashed, wedged,
 * or merely never started -- stops calling this at all, and the switch
 * itself (via the Healthchecks period/grace configured against it, which
 * this module treats as an external, incidental tuning knob) turns Late
 * then Down on its own schedule, no timer or watchdog needed here.
 *
 * The ping itself is fire-and-forget: `onCycleComplete()` never returns a
 * promise the caller could accidentally await, because awaiting a slow or
 * hung ping request inside the collector's own poll loop would make the
 * switch's own liveness check the next thing that wedges the worker it is
 * meant to protect.
 */
export function createDeadMansSwitch(opts: DeadMansSwitchOptions): DeadMansSwitch {
  const doFetch = opts.fetchImpl ?? fetch;
  const shouldPing = opts.shouldPing ?? (() => true);

  return {
    onCycleComplete(): void {
      if (!shouldPing()) {
        opts.log.warn('heartbeat_suppressed', {});
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
        });
    },
  };
}
