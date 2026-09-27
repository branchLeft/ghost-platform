import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';

/**
 * The falsification clause's own distinction (LLD-4 §04): "reported
 * healthy" must never stand in for "has served real traffic". This reads
 * the one signal in the estate that actually observes a real reader
 * request before it reaches a slot's colour pair -- `services/demo-gate`'s
 * `verify()`, which increments this same counter on every admitted request
 * (`trafficCounter.ts` there). The broker only ever reads it.
 */
export interface RealTrafficChecker {
  readCount(slot: SlotName): Promise<number>;
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | undefined)?.code === 'ENOENT';
}

/**
 * Reads the counter demo-gate owns and writes; this process never writes
 * to `dir`. Any failure to read -- missing file, unreadable directory, a
 * non-numeric file -- answers `0`, the same direction as "never observed
 * any traffic": a checker that cannot confirm a real request must not be
 * read as having confirmed one, which is the fail-closed half of the
 * stop-old-colour gate (`app.ts`'s `attemptStopOldColour`).
 */
export function createFileRealTrafficChecker(dir: string): RealTrafficChecker {
  return {
    async readCount(slot) {
      try {
        const text = await readFile(join(dir, `${slot}.count`), 'utf8');
        const parsed = Number.parseInt(text, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      } catch (err) {
        if (isEnoent(err)) return 0;
        return 0;
      }
    },
  };
}

/**
 * The safe default when no counter directory is configured
 * (`BrokerConfig.trafficCounterDir` unset): always `0`, so
 * `attemptStopOldColour` always refuses for want of evidence rather than
 * guessing traffic has moved.
 */
export function createZeroRealTrafficChecker(): RealTrafficChecker {
  return {
    async readCount() {
      return 0;
    },
  };
}
