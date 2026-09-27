import type { Logger } from './log.js';

export interface DeadMansSwitchOptions {
  url: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  /**
   * Checked only once every currently-expected target has reported a
   * successful cycle, right before the actual ping. Defaults to
   * always-true. A caller that wires this to something reflecting actual
   * submission progress (src/health.ts) is what stops a collector that
   * completes cycles but cannot submit anything -- every delivery
   * rejected, mx1 down -- from paging "healthy" forever just because its
   * loops are still turning over; see collectorLoop.ts's own wiring.
   */
  shouldPing?: () => boolean;
  /**
   * The live set of target ids this collector is currently expected to
   * drain -- read fresh on every `onCycleComplete()` call, never captured
   * once at construction, because the descriptor this answers from can
   * gain or lose a host mid-run (collectorLoop.ts's own `reconcile()`).
   * The switch pings only once EVERY id this returns has reported a
   * successful cycle since the last ping -- so any one host that is
   * wedged or permanently failing silences the whole switch, not just
   * its own share of it.
   */
  getExpectedTargetIds: () => readonly string[];
}

export interface DeadMansSwitch {
  /**
   * Call once per target, once per completed poll cycle for that target --
   * drained-and-delivered or drained-nothing, it does not matter which, an
   * EMPTY poll is a success. Never call it for a cycle that errored (a
   * drain failure against that host) or that never finished (a wedged
   * loop): omitting the call is exactly what silences the switch for that
   * target, per the owner ruling above. Never called on this module's own
   * timer, deliberately: a timer independent of the callers' loops keeps
   * firing exactly while one of them is wedged (blocked on an unresolved
   * fetch, a held socket, anything that never returns), and a ping driven
   * by anything other than every loop's own forward progress would report
   * that a stuck worker is alive. This is the mechanism behind LLD-8
   * §03b's dead-man's-switch requirement and its load-bearing mark:
   * *silence and failure must look identical, never silence looking like
   * health.*
   */
  onCycleComplete(targetId: string): void;
}

/**
 * The estate's shared dead-man's-switch client -- pings Healthchecks.io (or
 * the local instance standing in for it in proof) once per PERIOD in which
 * every currently-expected target has reported a completed poll cycle,
 * never on an interval of its own. An idle worker that keeps completing
 * empty cycles keeps pinging, so the switch stays up (LLD-8 §10b's control
 * case, load-bearing: *an idle worker with nothing to drain must not
 * page*); any one target whose loop stops progressing -- crashed, wedged,
 * or permanently failing its drain -- simply never reports again, which is
 * enough on its own to withhold every subsequent ping: many sites having
 * zero mail in a cycle is not a failure, but ONE site never completing a
 * cycle is, and it must silence the switch exactly as a fully wedged
 * worker would. The switch itself (via the Healthchecks period/grace configured
 * against it, which this module treats as an external, incidental tuning
 * knob) turns Late then Down on its own schedule once pings stop, no timer
 * or watchdog needed here.
 *
 * Bookkeeping: a target id reported via `onCycleComplete()` is held in a
 * per-period set until every id `getExpectedTargetIds()` currently names is
 * present, at which point the switch pings (subject to `shouldPing()`) and
 * the set is cleared for the next period. A target that drops out of the
 * expected set (removed from the descriptor) is simply no longer required;
 * one that is added starts the next period absent, same as any other.
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
  const completedSinceLastPing = new Set<string>();

  return {
    onCycleComplete(targetId: string): void {
      completedSinceLastPing.add(targetId);

      const expected = opts.getExpectedTargetIds();
      // Nothing to confirm yet (e.g. the descriptor store is empty or
      // stale) -- withhold the ping rather than treat an empty target list
      // as vacuously "everything succeeded".
      if (expected.length === 0) {
        return;
      }
      if (!expected.every((id) => completedSinceLastPing.has(id))) {
        return;
      }
      completedSinceLastPing.clear();

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
