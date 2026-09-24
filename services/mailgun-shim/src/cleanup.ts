import type { Logger } from './log.js';
import type { ShimStore } from './store.js';

/**
 * The deleted worker's own hourly cleanup tick, re-homed: nothing calls
 * `store.cleanupCompletedBatches` any more since worker.ts went away, so
 * without this, a completed batch's message body and recipient addresses
 * would be retained forever rather than the intended 30 days — data this
 * component has already finished with, sitting in the queue tables
 * indefinitely for no operational reason.
 */
export const CLEANUP_INTERVAL_SECONDS = 3600;
export const COMPLETED_BATCH_RETENTION_SECONDS = 30 * 24 * 3600;

export interface CleanupSchedulerOptions {
  intervalMs?: number;
  retentionSeconds?: number;
  now?: () => number;
}

export interface CleanupScheduler {
  stop(): void;
}

/**
 * Runs cleanup once immediately (matching the deleted worker's own
 * behaviour — its `lastCleanupAt` started at 0, so its first ever tick,
 * right at startup, always ran cleanup too) and then on a fixed interval.
 * `stop()` clears the interval; it does not run a final cleanup.
 */
export function startCleanupScheduler(
  store: ShimStore,
  log: Logger,
  opts: CleanupSchedulerOptions = {}
): CleanupScheduler {
  const now = opts.now ?? (() => Date.now() / 1000);
  const intervalMs = opts.intervalMs ?? CLEANUP_INTERVAL_SECONDS * 1000;
  const retentionSeconds = opts.retentionSeconds ?? COMPLETED_BATCH_RETENTION_SECONDS;

  function tick(): void {
    const deleted = store.cleanupCompletedBatches(now() - retentionSeconds);
    if (deleted > 0) {
      log.info('queue_cleanup', { deletedBatches: deleted });
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
