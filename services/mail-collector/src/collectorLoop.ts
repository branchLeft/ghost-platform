import { createSubmittedTracker, type SubmittedTracker } from './dedupe.js';
import type { DrainClient, WireMessage } from './drainClient.js';
import type { DeadMansSwitch } from '@branchleft/ghost-platform-deadmans-switch';
import type { DeliveryClient } from './deliveryClient.js';
import type { DrainTarget, TargetStore } from './descriptorTargets.js';
import type { DroppedOutcomes } from './droppedOutcomes.js';
import type { HealthState } from './health.js';
import { isBulkDeferral, laneOf, type BulkCap, type Lane } from './lanes.js';
import { checkHeaderFrom } from './headerFromScope.js';
import type { Logger } from './log.js';
import type { OutcomeRunner } from './outcomeRunner.js';
import {
  QUOTA_UNKNOWN,
  failureKindOf,
  mailClassOf,
  resolveSendingTarget,
  type SendingContext,
  type SendingDecision,
  type SweegoQuota,
} from './sendingTarget.js';
import type { FailureCounter } from './submissionFailures.js';
import { failureReasonOf } from './sweegoFailure.js';
import { DEFAULT_PIN_TTL_MS, type SweegoUseCounter } from './sweegoUsage.js';
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
  /**
   * Unset means unknown, which the resolver reads as "reached": nothing goes
   * to Sweego. A quota that also counts (`begin`) is told of each Sweego
   * attempt and whether it was accepted; `createSweegoUsage` is the one that does.
   */
  sweegoQuota?: SweegoQuota & Partial<SweegoUseCounter>;
  /** Ids whose submission has reached mx1; such a message is never offered to Sweego. Memory-only if unset. */
  mx1Pins?: SubmittedTracker;
  /** Ids whose first attempt was at Sweego; a retry stays on Sweego until the login fallback reaches mx1. Memory-only if unset. */
  sweegoPins?: SubmittedTracker;
  /**
   * Ids whose attempt at Sweego ended ambiguous (it may have been taken). Such
   * a message never falls back to mx1 on a later definite failure: the first
   * attempt may have been delivered. Memory-only if unset.
   */
  sweegoAmbiguous?: SubmittedTracker;
  /**
   * Tells the spool a dropped recipient failed for good, once the drop is acked.
   * Unset, the spool is not told and shows the message as accepted.
   */
  droppedOutcomes?: DroppedOutcomes;
  /**
   * Counts failures by reason class for the signals that read them: Sweego
   * failures, and the header From refusals on either target. Counts nothing if unset.
   */
  sweegoFailures?: FailureCounter;
  /**
   * Checks each message's header From against its host's sending domain before
   * any target sees it, on both targets. `server.ts` always sets it; it is
   * optional only so the test doubles that build deps by hand need not.
   * See ../README.md#header-from-scope.
   */
  enforceHeaderFrom?: boolean;
  /** The bulk lane's bucket. Login mail uses it only when `loginThrottle` is absent. */
  throttle: Throttle;
  /** Optional login lane: its own bucket, so sign-in mail never spends bulk tokens. */
  loginThrottle?: Throttle;
  /** Optional: a receiving-side deferral on a bulk submission halves the bulk rate for a hold period. */
  bulkCap?: BulkCap;
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
// The shim re-offers an unacked row every SHIM_DRAIN_LEASE_SECONDS (30 s by default)
// with no attempt cap and no maximum age, so the pin TTL alone bounds a held
// message. It outlasts the longest cap hold: see ../README.md#dedupe-createsubmittedtracker.

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
  const mx1Pins = deps.mx1Pins ?? createSubmittedTracker(DEFAULT_PIN_TTL_MS);
  const sweegoPins = deps.sweegoPins ?? createSubmittedTracker(DEFAULT_PIN_TTL_MS);
  const sweegoAmbiguous = deps.sweegoAmbiguous ?? createSubmittedTracker(DEFAULT_PIN_TTL_MS);
  const quota = deps.sweegoQuota ?? QUOTA_UNKNOWN;
  const servedByMx1Logged = new Set<string>();
  // Pinned messages the last offer left held at the account cap. Their pins are
  // never swept: a swept pin would let the message be decided afresh.
  const heldAtCapIds = new Set<string>();
  const isHeldAtCap = (id: string): boolean => heldAtCapIds.has(id);

  /**
   * Submits one message through the target the resolver names. `submitted`:
   * a target accepted it. `dropped`: Sweego refused the recipient for good, so
   * the message is acked and counted, never retried. `refused`: its header From
   * is not in its host's scope, so it is acked and counted the same way but
   * never reported to the spool as a bounce (that would suppress an innocent
   * recipient). `held`: left unacked for
   * the shim to re-offer, and the rest of the batch carries on (Sweego said
   * no, mx1 was not tried). `stop`: mx1 failed, so the rest of the batch is
   * left too, as it always was. Sweego mail spends Sweego's own throttle,
   * never mx1's, and never touches the mx1 health counter; mx1 mail does
   * exactly what it did before a second target existed.
   */
  async function submit(
    message: WireMessage,
    target: DrainTarget
  ): Promise<'submitted' | 'dropped' | 'refused' | 'held' | 'stop'> {
    // Asked afresh on every offer: only a message the latest offer left held at
    // the cap is protected from the pin sweep.
    heldAtCapIds.delete(message.id);
    if (deps.enforceHeaderFrom) {
      const verdict = checkHeaderFrom(message, target.sendingDomain);
      if (!verdict.ok) {
        deps.sweegoFailures?.record(verdict.reason);
        // The line names a reason and a message id only: no host, address,
        // subject or domain.
        deps.log.warn('header_from_refused', { message: message.id, reason: verdict.reason });
        if (verdict.reason === 'from-scope-unknown') {
          // Nothing is wrong with the message: its host has no sending domain
          // to check against yet. Left unacked, the spool re-offers it.
          return 'held';
        }
        // Permanent, and the same ending as a dropped recipient: marked so a
        // lost ack is only re-acked on the next offer, never sent or retried.
        deps.dedupe.markSubmitted(message.id, true);
        return 'refused';
      }
    }
    const lane = laneOf(message);
    const sweego = deps.sweegoDeliveryClient;
    const sweegoThrottle = deps.sweegoThrottle;
    const sweegoReady = sweego !== undefined && sweegoThrottle !== undefined;
    const reachedMx1 = mx1Pins.has(message.id);
    // A message whose first attempt was at Sweego stays there: the route and
    // the quota may have changed since, but an earlier attempt may have been
    // taken, so a retry elsewhere could send it twice.
    const pinnedToSweego = !reachedMx1 && sweegoPins.has(message.id);
    // A pin file that could not be read has forgotten which targets saw which
    // messages. A message offered before (drainCount above 1) and not found in
    // any pin may have been taken by either target, so it is held, never sent
    // on: a held message waits, a released one can be sent twice.
    const pinStateLost = mx1Pins.stateLost || sweegoPins.stateLost || sweegoAmbiguous.stateLost;
    const known = reachedMx1 || pinnedToSweego || sweegoAmbiguous.has(message.id);
    if (pinStateLost && target.route === 'sweego' && message.drainCount > 1 && !known) {
      deps.log.warn('pin_state_lost_held', { target: target.id, message: message.id });
      return 'held';
    }
    if (pinnedToSweego && !sweegoReady) {
      deps.log.warn('sweego_pinned_unavailable', { target: target.id, message: message.id });
      return 'held';
    }
    const mailClass = mailClassOf(message.emailId);
    // Asked afresh each time: the quota can change while a message waits on a
    // throttle. Login mail never consults the tenant's latch (its newsletters
    // moving to mx1 is no reason to move a sign-in link), but the account cap
    // is the plan's ceiling and holds for every class. A pinned message
    // stays on Sweego whatever the tenant's allowance now says, and is counted;
    // the account cap holds for it too (see `resolveNow`).
    // A pinned message that was already counted (an earlier attempt ended
    // ambiguous, or its reserved place was recounted after a crash) holds its
    // place in the cap: a retry takes no second one, so the cap does not hold it.
    const holdsPlace = (): boolean =>
      pinnedToSweego && deps.sweegoQuota?.holdsPlace?.(message.id) === true;
    const contextNow = (): SendingContext => ({
      mailClass,
      demo: target.demo === true,
      sweegoConfigured: sweegoReady,
      allowanceReached:
        pinnedToSweego || mailClass === 'transactional' ? false : quota.allowanceReached(target.id),
      accountCapReached: holdsPlace() ? false : quota.accountCapReached(),
      reachedMx1,
    });
    const route = pinnedToSweego ? 'sweego' : target.route;
    // A pinned message cannot move to mx1 (its first attempt may have been
    // taken) and must not go above the cap, so at the cap it waits. Undefined
    // means exactly that.
    const resolveNow = (): SendingDecision | undefined => {
      const context = contextNow();
      return pinnedToSweego && context.accountCapReached
        ? undefined
        : resolveSendingTarget(route, context);
    };
    const heldAtCap = (): 'held' => {
      heldAtCapIds.add(message.id);
      deps.log.warn('sweego_pinned_held_at_cap', { target: target.id, message: message.id });
      return 'held';
    };
    let decision = resolveNow();
    if (decision === undefined) {
      return heldAtCap();
    }
    if (decision === 'sweego') {
      if (!sweegoReady) {
        // Not reachable while the resolver reads `sweegoConfigured`; a message
        // is never marked submitted without a client having taken it.
        deps.log.warn('sweego_client_missing', { target: target.id, message: message.id });
        return 'held';
      }
      await sweegoThrottle.waitForToken();
      // The wait can be long, and other tenants can have used the plan in the
      // meantime: ask again, and begin the attempt in the same tick.
      decision = resolveNow();
      if (decision === undefined) {
        return heldAtCap();
      }
    }
    if (decision === 'sweego' && sweegoReady) {
      // The place is reserved, and written down, before the pin and before the
      // attempt: a crash after this point leaves it counted. Refused, nothing
      // was sent and nothing is pinned, so the message is held and offered again.
      const counter = deps.sweegoQuota;
      const slot = counter?.begin?.(target.id, message.id);
      if (slot === undefined && counter?.begin !== undefined) {
        deps.log.warn('sweego_reservation_failed', { target: target.id, message: message.id });
        return 'held';
      }
      // Before the attempt, not after the accept: an attempt that times out
      // may still have been taken.
      sweegoPins.markSubmitted(message.id);
      let accepted = false;
      try {
        await sweego.deliver(message, target.id);
        accepted = true;
      } catch (error) {
        const kind = failureKindOf(error);
        // An attempt that may have been taken is counted, once per message; any
        // other end (a definite refusal, a bad address) used nothing.
        if (kind === 'ambiguous') {
          slot?.ambiguous();
        } else {
          slot?.settle(false);
        }
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
          deps.dedupe.markSubmitted(message.id, true);
          deps.log.warn('recipient_rejected_dropped', { target: target.id, message: message.id });
          return 'dropped';
        }
        // An attempt that may have been taken is remembered, and a later definite
        // failure is then read as ambiguous too: falling back to mx1 would send
        // a second copy of what the first attempt may have delivered.
        if (kind === 'ambiguous') {
          sweegoAmbiguous.markSubmitted(message.id);
        }
        decision = resolveSendingTarget('sweego', {
          ...contextNow(),
          failed: {
            target: 'sweego',
            kind: sweegoAmbiguous.has(message.id) ? 'ambiguous' : kind,
          },
        });
      }
      if (accepted) {
        // Without this a lost ack re-sends the message to Sweego. Marked
        // before the count, so a crash between the two undercounts by one
        // rather than sending the message twice.
        deps.dedupe.markSubmitted(message.id, true);
        slot?.settle(true);
        deps.log.info('submitted', { target: target.id, message: message.id, via: 'sweego' });
        return 'submitted';
      }
    }
    if (decision === 'mx1' && target.route === 'sweego' && !servedByMx1Logged.has(target.id)) {
      servedByMx1Logged.add(target.id);
      deps.log.warn('sweego_route_served_by_mx1', { target: target.id });
    }
    if (decision !== 'mx1') {
      // Left unacked: the shim re-offers it and the resolver is asked again.
      return 'held';
    }
    await throttleFor(lane).waitForToken();
    mx1Pins.markSubmitted(message.id);
    try {
      await deps.deliveryClient.deliver(message, target.id);
    } catch (error) {
      deps.health.recordFailure();
      if (lane === 'bulk' && deps.bulkCap && isBulkDeferral(error)) {
        deps.bulkCap.recordDeferral();
        // The halved rate must not meet a full bucket: empty it, so the lower
        // rate starts from nothing and no burst follows the deferral. Only
        // this mx1 branch reaches the cap; the Sweego path never does.
        throttleFor('bulk').empty();
        deps.log.warn('bulk_deferred', { target: target.id, message: message.id });
      }
      deps.log.warn('submission_failed', {
        target: target.id,
        message: message.id,
        error: (error as Error).message,
      });
      return 'stop';
    }
    deps.health.recordSuccess();
    // Awaiting its ack: a batch at a low ramp rate can outlast the TTL, and
    // the id must not be swept before the shim has taken it.
    deps.dedupe.markSubmitted(message.id, true);
    // "submitted", not "delivered" -- see dedupe.ts's own doc comment (LLD-6
    // M5): this only means the target's SMTP front accepted the message,
    // never that it confirmed delivery to the recipient.
    deps.log.info('submitted', { target: target.id, message: message.id });
    return 'submitted';
  }

  function findTarget(id: string): DrainTarget | undefined {
    return deps.store.targets.find((t) => t.id === id);
  }

  function throttleFor(lane: Lane): Throttle {
    return lane === 'login' ? (deps.loginThrottle ?? deps.throttle) : deps.throttle;
  }

  function inLaneOrder<T extends { emailId: string | null }>(batch: readonly T[]): T[] {
    return [
      ...batch.filter((m) => laneOf(m) === 'login'),
      ...batch.filter((m) => laneOf(m) === 'bulk'),
    ];
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
        await deps.droppedOutcomes?.flush(target);
        deps.heartbeat?.onCycleComplete(initialTarget.id);
        await sleep(deps.emptyPollBackoffMs);
        continue;
      }

      const acks: Array<{ id: string; drainCount: number }> = [];
      // Login mail first, so a batch that mixes it with a bulk backlog never
      // makes sign-in mail wait for bulk tokens. Each lane spends its own bucket.
      for (const message of inLaneOrder(messages)) {
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
          if (result === 'dropped') {
            deps.droppedOutcomes?.dropped(target.id, message.id, message.drainCount);
          }
        } else {
          deps.log.info('resubmission_skipped', {
            target: initialTarget.id,
            message: message.id,
          });
          deps.droppedOutcomes?.offered(message.id, message.drainCount);
        }
        acks.push({ id: message.id, drainCount: message.drainCount });
      }

      if (acks.length > 0) {
        try {
          const result = await deps.drainClient.ack(target, acks);
          deps.dedupe.markAcked([...result.acked, ...result.alreadyHandled]);
          deps.droppedOutcomes?.acked(result);
        } catch (error) {
          deps.log.warn('ack_failed', {
            target: initialTarget.id,
            error: (error as Error).message,
          });
          // The ack is lost, not the submission: dedupe already holds
          // every id acks contains, and keeps it past the TTL until an ack
          // lands, so the next re-offer (once the lease lapses) is
          // recognised and only re-acked, never resubmitted.
        }
      }

      await deps.droppedOutcomes?.flush(target);

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
        sweegoPins.sweep(isHeldAtCap);
        sweegoAmbiguous.sweep(isHeldAtCap);
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
