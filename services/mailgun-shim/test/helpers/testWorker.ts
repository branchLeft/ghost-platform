import type { Transporter } from '../../src/smtp.js';
import type { ShimStore } from '../../src/store.js';
import { createWorker, type WorkerHandle, type WorkerOptions } from '../../src/worker.js';
import { createTestLogger } from './testLogger.js';
import { createUnlimitedThrottle } from './testThrottle.js';

/** Wires a worker with sensible test defaults (unlimited throttle, a discarding logger) so most tests don't need to. */
export function createTestWorker(
  store: ShimStore,
  transport: Transporter,
  overrides: Partial<Omit<WorkerOptions, 'store' | 'transport'>> = {}
): WorkerHandle {
  return createWorker({
    store,
    transport,
    throttle: overrides.throttle ?? createUnlimitedThrottle(),
    log: overrides.log ?? createTestLogger().logger,
    now: overrides.now,
    tickIntervalMs: overrides.tickIntervalMs,
    claimBatchSize: overrides.claimBatchSize,
  });
}
