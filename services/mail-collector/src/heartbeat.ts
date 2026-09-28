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
   * Call once per target, once per completed poll cycle -- an empty poll
   * counts as success. Never call it for an errored or wedged cycle:
   * omitting the call is exactly what silences the switch for that target.
   * See ../README.md#heartbeat-oncyclecomplete.
   */
  onCycleComplete(targetId: string): void;
}

/**
 * Pings Healthchecks.io once per period in which every currently-expected
 * target has reported a completed cycle, never on its own timer -- any one
 * wedged or failing target withholds every subsequent ping (LLD-8 §10b).
 * Fire-and-forget: `onCycleComplete()` never returns a promise the caller
 * could accidentally await.
 * See ../README.md#heartbeat-createdeadmansswitch.
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
