import type { SubmittedTracker } from './dedupe.js';
import type { DrainClient } from './drainClient.js';
import type { DeadMansSwitch } from './heartbeat.js';
import type { DeliveryClient } from './deliveryClient.js';
import type { DrainTarget, TargetStore } from './descriptorTargets.js';
import type { HealthState } from './health.js';
import type { Logger } from './log.js';
import type { OutcomeRunner } from './outcomeRunner.js';
import type { Throttle } from './throttle.js';

export interface CollectorLoopDeps {
  store: TargetStore;
  drainClient: DrainClient;
  deliveryClient: DeliveryClient;
  throttle: Throttle;
  dedupe: SubmittedTracker;
  health: HealthState;
  /**
   * Optional so every existing test double that builds deps by hand does
   * not also have to grow a heartbeat -- omitted, the loop simply never
   * calls it. `server.ts` always supplies one against a running worker.
   */
  heartbeat?: DeadMansSwitch;
  log: Logger;
  descriptorRefreshMs: number;
  drainRetryBackoffMs: number;
  emptyPollBackoffMs: number;
  dedupeSweepMs?: number;
  /** Optional, off unless supplied: carries mx1's outcomes back to the spools on a timer. */
  outcomes?: { runner: OutcomeRunner; intervalMs: number };
}

export interface CollectorRuntime {
  start(): void;
  stop(): Promise<void>;
}

const DEFAULT_DEDUPE_SWEEP_MS = 5 * 60 * 1000;

/**
 * Reconciles one drain-and-deliver loop per descriptor-named host on every
 * refresh; a host absent or removed never gets a loop at all (LLD-6 §09).
 * `deps.throttle` and `deps.health` are shared across every target loop,
 * never constructed per-target.
 * See ../README.md#collectorloop-createcollectorruntime.
 */
export function createCollectorRuntime(deps: CollectorLoopDeps): CollectorRuntime {
  const running = new Map<string, { stopped: boolean; done: Promise<void> }>();
  let globalStop = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  let outcomeTimer: ReturnType<typeof setTimeout> | undefined;
  let outcomeInFlight: Promise<unknown> = Promise.resolve();
  let outcomeRunning = false;

  function findTarget(id: string): DrainTarget | undefined {
    return deps.store.targets.find((t) => t.id === id);
  }

  function reconcile(): void {
    const targets = deps.store.targets;
    const targetById = new Map(targets.map((t) => [t.id, t]));

    for (const target of targets) {
      if (!running.has(target.id)) {
        const state = { stopped: false, done: Promise.resolve() };
        running.set(target.id, state);
        // However the loop ends -- stopped, descriptor gone, or a thrown
        // error -- its id leaves `running`, so the next reconcile starts a
        // fresh loop once the descriptor is fresh again. Without this a
        // stale descriptor halted that host's drain until process restart.
        // The identity check keeps a finishing loop from removing a newer
        // loop registered under the same id.
        state.done = runTargetLoop(target, state)
          .catch((error: unknown) => {
            deps.log.warn('drain_loop_crashed', {
              target: target.id,
              error: (error as Error).message,
            });
          })
          .finally(() => {
            if (running.get(target.id) === state) {
              running.delete(target.id);
            }
          });
      }
    }

    for (const [id, state] of running) {
      if (!targetById.has(id)) {
        state.stopped = true;
      }
    }
  }

  async function runTargetLoop(
    initialTarget: DrainTarget,
    state: { stopped: boolean }
  ): Promise<void> {
    while (!globalStop && !state.stopped) {
      // Re-read the live target on every iteration, not just its id: a
      // descriptor refresh can change a host's own address (a rare case,
      // but the descriptor -- never a value captured at loop start -- is
      // what LLD-6 §09 says decides who is drained and how they are
      // reached).
      const target = findTarget(initialTarget.id);
      if (!target) {
        return;
      }

      // Re-read on every iteration, not once at start-up: an operator's
      // throttle-file edit (the estate-wide ceiling this story relocates
      // here) must take effect within one poll cycle across every host
      // this process drains, the same reasoning the shim's own drain.ts
      // calls `throttle.reload()` on every hold-loop iteration for.
      // `reload()` is a single stat() call when the file's mtime hasn't
      // changed, so paying for it once per target per poll costs nothing
      // on the common path.
      deps.throttle.reload();

      let messages;
      try {
        messages = await deps.drainClient.drain(target);
      } catch (error) {
        deps.log.warn('drain_failed', {
          target: initialTarget.id,
          error: (error as Error).message,
        });
        // A drain failure against this host is never routed into
        // health.ts (see its own header comment) -- one host's routine
        // outage is not "the collector is stuck". But it IS routed into
        // silence for the switch: gating is per-host, so a host that
        // cannot complete a cycle must withhold ITS report and silence
        // the whole switch, exactly as a wedged loop would. No
        // `onCycleComplete()` call here, deliberately.
        await sleep(deps.drainRetryBackoffMs);
        continue;
      }
      if (messages.length === 0) {
        deps.heartbeat?.onCycleComplete(initialTarget.id);
        await sleep(deps.emptyPollBackoffMs);
        continue;
      }

      const acks: Array<{ id: string; drainCount: number }> = [];
      for (const message of messages) {
        if (!deps.dedupe.has(message.id)) {
          await deps.throttle.waitForToken();
          try {
            await deps.deliveryClient.deliver(message, initialTarget.id);
          } catch (error) {
            deps.health.recordFailure();
            deps.log.warn('submission_failed', {
              target: initialTarget.id,
              message: message.id,
              error: (error as Error).message,
            });
            // Leave this message and the rest of the batch unacked -- the
            // shim's lease lapses and re-offers them; nothing here has
            // been marked submitted, so a retry (here or on another
            // collector) still runs deliver() exactly once per id.
            break;
          }
          deps.health.recordSuccess();
          deps.dedupe.markSubmitted(message.id);
          // "submitted", not "delivered" -- see dedupe.ts's own doc
          // comment (LLD-6 M5): this only means mx1's SMTP front accepted
          // the message, never that it confirmed delivery to the
          // recipient.
          deps.log.info('submitted', { target: initialTarget.id, message: message.id });
        } else {
          deps.log.info('resubmission_skipped', {
            target: initialTarget.id,
            message: message.id,
          });
        }
        acks.push({ id: message.id, drainCount: message.drainCount });
      }

      if (acks.length > 0) {
        try {
          await deps.drainClient.ack(target, acks);
        } catch (error) {
          deps.log.warn('ack_failed', {
            target: initialTarget.id,
            error: (error as Error).message,
          });
          // The ack is lost, not the submission: dedupe already holds
          // every id acks contains, so the next re-offer (once the lease
          // lapses) is recognised and only re-acked, never resubmitted.
        }
      }

      // A cycle that drained and (attempted to) submit something still
      // completed -- report it regardless of whether every delivery in it
      // succeeded. A submission failure is health.ts's signal, carried
      // into shouldPing() inside the switch itself; duplicating that
      // decision here would just be a second, divergent place to get it
      // wrong.
      deps.heartbeat?.onCycleComplete(initialTarget.id);
    }
  }

  return {
    start() {
      reconcile();
      refreshTimer = setInterval(() => {
        deps.store
          .refresh()
          .catch((error: unknown) => {
            deps.log.warn('descriptor_refresh_failed', { error: (error as Error).message });
          })
          .finally(reconcile);
      }, deps.descriptorRefreshMs);
      refreshTimer.unref?.();

      sweepTimer = setInterval(
        () => deps.dedupe.sweep(),
        deps.dedupeSweepMs ?? DEFAULT_DEDUPE_SWEEP_MS
      );
      sweepTimer.unref?.();

      const outcomes = deps.outcomes;
      if (outcomes) {
        outcomeTimer = setInterval(() => {
          if (outcomeRunning || globalStop) {
            return;
          }
          outcomeRunning = true;
          outcomeInFlight = outcomes.runner.runOnce().finally(() => {
            outcomeRunning = false;
          });
        }, outcomes.intervalMs);
        outcomeTimer.unref?.();
      }
    },
    async stop(): Promise<void> {
      globalStop = true;
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
      }
      if (outcomeTimer) {
        clearInterval(outcomeTimer);
      }
      for (const state of running.values()) {
        state.stopped = true;
      }
      await Promise.allSettled([...running.values()].map((s) => s.done));
      await Promise.allSettled([outcomeInFlight]);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
