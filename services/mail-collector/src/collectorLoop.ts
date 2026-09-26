import type { DeliveredTracker } from './dedupe.js';
import type { DrainClient } from './drainClient.js';
import type { DeliveryClient } from './deliveryClient.js';
import type { DrainTarget, TargetStore } from './descriptorTargets.js';
import type { Logger } from './log.js';
import type { Throttle } from './throttle.js';

export interface CollectorLoopDeps {
  store: TargetStore;
  drainClient: DrainClient;
  deliveryClient: DeliveryClient;
  throttle: Throttle;
  dedupe: DeliveredTracker;
  log: Logger;
  descriptorRefreshMs: number;
  drainRetryBackoffMs: number;
  emptyPollBackoffMs: number;
  dedupeSweepMs?: number;
}

export interface CollectorRuntime {
  start(): void;
  stop(): Promise<void>;
}

const DEFAULT_DEDUPE_SWEEP_MS = 5 * 60 * 1000;

/**
 * Runs one drain-and-deliver loop per host the descriptor currently names,
 * and reconciles that set of loops every `descriptorRefreshMs` against
 * whatever the descriptor now says -- adding a loop for a host that just
 * appeared, and retiring one for a host that dropped out or expired. A
 * host absent from the descriptor at construction time, or removed from it
 * later, never gets a loop at all: this is the mechanism behind LLD-6 §09's
 * load-bearing property, that a host not in the drain list is a host whose
 * mail is never collected, however reachable it stays on the network.
 */
export function createCollectorRuntime(deps: CollectorLoopDeps): CollectorRuntime {
  const running = new Map<string, { stopped: boolean; done: Promise<void> }>();
  let globalStop = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;

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
        state.done = runTargetLoop(target, state);
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
      let messages;
      try {
        messages = await deps.drainClient.drain(target);
      } catch (error) {
        deps.log.warn('drain_failed', {
          target: initialTarget.id,
          error: (error as Error).message,
        });
        await sleep(deps.drainRetryBackoffMs);
        continue;
      }
      if (messages.length === 0) {
        await sleep(deps.emptyPollBackoffMs);
        continue;
      }

      const acks: Array<{ id: string; drainCount: number }> = [];
      for (const message of messages) {
        if (!deps.dedupe.has(message.id)) {
          await deps.throttle.waitForToken();
          try {
            await deps.deliveryClient.deliver(message);
          } catch (error) {
            deps.log.warn('delivery_failed', {
              target: initialTarget.id,
              message: message.id,
              error: (error as Error).message,
            });
            // Leave this message and the rest of the batch unacked -- the
            // shim's lease lapses and re-offers them; nothing here has
            // been marked delivered, so a retry (here or on another
            // collector) still runs deliver() exactly once per id.
            break;
          }
          deps.dedupe.markDelivered(message.id);
          deps.log.info('delivered', { target: initialTarget.id, message: message.id });
        } else {
          deps.log.info('redelivery_skipped', {
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
          // The ack is lost, not the delivery: dedupe already holds every
          // id acks contains, so the next re-offer (once the lease lapses)
          // is recognised and only re-acked, never redelivered.
        }
      }
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
    },
    async stop(): Promise<void> {
      globalStop = true;
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
      }
      for (const state of running.values()) {
        state.stopped = true;
      }
      await Promise.allSettled([...running.values()].map((s) => s.done));
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
