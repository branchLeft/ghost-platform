import { createSubmittedTracker, type SubmittedTracker } from './dedupe.js';
import type { DrainClient, WireMessage } from './drainClient.js';
import type { DeadMansSwitch } from '@branchleft/ghost-platform-deadmans-switch';
import type { DeliveryClient } from './deliveryClient.js';
import type { DrainTarget, TargetStore } from './descriptorTargets.js';
import type { HealthState } from './health.js';
import type { Logger } from './log.js';
import type { OutcomeRunner } from './outcomeRunner.js';
import {
  QUOTA_UNKNOWN,
  failureKindOf,
  mailClassOf,
  resolveSendingTarget,
  type SendingContext,
  type SweegoQuota,
} from './sendingTarget.js';
import type { FailureCounter } from './submissionFailures.js';
import { failureReasonOf } from './sweegoFailure.js';
import type { Throttle } from './throttle.js';

export interface CollectorLoopDeps {
  store: TargetStore;
  drainClient: DrainClient;
  /** The mx1 delivery client: the only target delivered to when `sweegoDeliveryClient` is unset. */
  deliveryClient: DeliveryClient;
  /** Unset until a Sweego client exists: a Sweego route is then served by mx1, exactly as before the route existed. */
  sweegoDeliveryClient?: DeliveryClient;
  /**
   * Sweego's own throttle, separate from `throttle` (mx1's). A Sweego client
   * without one is read as not configured: nothing is sent to Sweego unthrottled.
   */
  sweegoThrottle?: Throttle;
  /** Unset means unknown, which the resolver reads as "reached": nothing goes to Sweego. */
  sweegoQuota?: SweegoQuota;
  /** Ids whose submission has reached mx1; such a message is never offered to Sweego. Memory-only if unset. */
  mx1Pins?: SubmittedTracker;
  /** Ids whose first attempt was at Sweego; a retry stays on Sweego until the login fallback reaches mx1. Memory-only if unset. */
  sweegoPins?: SubmittedTracker;
  /** Counts Sweego failures by reason class for the signals that read them. Counts nothing if unset. */
  sweegoFailures?: FailureCounter;
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
// UNPROVEN: must outlast the shim's longest retry horizon; read it from the shim before the pin is made persistent.
const DEFAULT_MX1_PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  const mx1Pins = deps.mx1Pins ?? createSubmittedTracker(DEFAULT_MX1_PIN_TTL_MS);
  const sweegoPins = deps.sweegoPins ?? createSubmittedTracker(DEFAULT_MX1_PIN_TTL_MS);
  const quota = deps.sweegoQuota ?? QUOTA_UNKNOWN;
  const servedByMx1Logged = new Set<string>();

  /**
   * Submits one message through the target the resolver names. `submitted`:
   * a target accepted it. `dropped`: Sweego refused the recipient for good, so
   * the message is acked and counted, never retried. `held`: left unacked for
   * the shim to re-offer, and the rest of the batch carries on (Sweego said
   * no, mx1 was not tried). `stop`: mx1 failed, so the rest of the batch is
   * left too, as it always was. Sweego mail spends Sweego's own throttle,
   * never mx1's, and never touches the mx1 health counter; mx1 mail does
   * exactly what it did before a second target existed.
   */
  async function submit(
    message: WireMessage,
    target: DrainTarget
  ): Promise<'submitted' | 'dropped' | 'held' | 'stop'> {
    const sweego = deps.sweegoDeliveryClient;
    const sweegoThrottle = deps.sweegoThrottle;
    const sweegoReady = sweego !== undefined && sweegoThrottle !== undefined;
    const reachedMx1 = mx1Pins.has(message.id);
    // A message whose first attempt was at Sweego stays there: the route and
    // the quota may have changed since, but an earlier attempt may have been
    // taken, so a retry elsewhere could send it twice.
    const pinnedToSweego = !reachedMx1 && sweegoPins.has(message.id);
    if (pinnedToSweego && !sweegoReady) {
      deps.log.warn('sweego_pinned_unavailable', { target: target.id, message: message.id });
      return 'held';
    }
    const context: SendingContext = {
      mailClass: mailClassOf(message.emailId),
      demo: target.demo === true,
      sweegoConfigured: sweegoReady,
      allowanceReached: pinnedToSweego ? false : quota.allowanceReached(target.id),
      accountCapReached: pinnedToSweego ? false : quota.accountCapReached(),
      reachedMx1,
    };
    let decision = resolveSendingTarget(pinnedToSweego ? 'sweego' : target.route, context);
    if (decision === 'sweego') {
      if (!sweegoReady) {
        // Not reachable while the resolver reads `sweegoConfigured`; a message
        // is never marked submitted without a client having taken it.
        deps.log.warn('sweego_client_missing', { target: target.id, message: message.id });
        return 'held';
      }
      await sweegoThrottle.waitForToken();
      // Before the attempt, not after the accept: an attempt that times out
      // may still have been taken.
      sweegoPins.markSubmitted(message.id);
      try {
        await sweego.deliver(message, target.id);
        // Without this a lost ack re-sends the message to Sweego.
        deps.dedupe.markSubmitted(message.id);
        deps.log.info('submitted', { target: target.id, message: message.id, via: 'sweego' });
        return 'submitted';
      } catch (error) {
        const kind = failureKindOf(error);
        const reason = failureReasonOf(error);
        deps.sweegoFailures?.record(reason);
        deps.log.warn('sweego_submission_failed', {
          target: target.id,
          message: message.id,
          kind,
          reason,
          error: (error as Error).message,
        });
        if (kind === 'recipient-rejected') {
          // Terminal: a bad address is bad everywhere. Marked so a lost ack
          // is only re-acked on the next offer, never sent or retried.
          deps.dedupe.markSubmitted(message.id);
          deps.log.warn('recipient_rejected_dropped', { target: target.id, message: message.id });
          return 'dropped';
        }
        decision = resolveSendingTarget('sweego', {
          ...context,
          failed: { target: 'sweego', kind },
        });
      }
    } else if (target.route === 'sweego' && !servedByMx1Logged.has(target.id)) {
      servedByMx1Logged.add(target.id);
      deps.log.warn('sweego_route_served_by_mx1', { target: target.id });
    }
    if (decision !== 'mx1') {
      // Left unacked: the shim re-offers it and the resolver is asked again.
      return 'held';
    }
    await deps.throttle.waitForToken();
    mx1Pins.markSubmitted(message.id);
    try {
      await deps.deliveryClient.deliver(message, target.id);
    } catch (error) {
      deps.health.recordFailure();
      deps.log.warn('submission_failed', {
        target: target.id,
        message: message.id,
        error: (error as Error).message,
      });
      return 'stop';
    }
    deps.health.recordSuccess();
    deps.dedupe.markSubmitted(message.id);
    // "submitted", not "delivered" -- see dedupe.ts's own doc comment (LLD-6
    // M5): this only means the target's SMTP front accepted the message,
    // never that it confirmed delivery to the recipient.
    deps.log.info('submitted', { target: target.id, message: message.id });
    return 'submitted';
  }

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
      deps.sweegoThrottle?.reload();

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
          const result = await submit(message, target);
          if (result === 'stop') {
            // Leave this message and the rest of the batch unacked -- the
            // shim's lease lapses and re-offers them; nothing here has
            // been marked submitted, so a retry (here or on another
            // collector) still runs deliver() exactly once per id.
            break;
          }
          if (result === 'held') {
            continue;
          }
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

      sweepTimer = setInterval(() => {
        deps.dedupe.sweep();
        mx1Pins.sweep();
        sweegoPins.sweep();
      }, deps.dedupeSweepMs ?? DEFAULT_DEDUPE_SWEEP_MS);
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
