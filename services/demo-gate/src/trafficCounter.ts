import { open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';

/**
 * A per-slot count of real reader requests, incremented once for every
 * `verify()` call that admits the request. Colour-blind by construction.
 * See ../README.md#the-traffic-counter.
 */
export interface TrafficCounterStore {
  increment(slot: SlotName): Promise<void>;
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | undefined)?.code === 'ENOENT';
}

function countPath(dir: string, slot: SlotName): string {
  return join(dir, `${slot}.count`);
}

async function writeCountAtomic(path: string, value: number): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${Math.random().toString(36).slice(2)}.tmp`);
  const handle = await open(tmpPath, 'wx', 0o644);
  try {
    await handle.writeFile(String(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, path);
}

/**
 * `dir` is this process's own, broker-readable directory -- never a
 * directory the broker itself writes into. Read-modify-write is serialised
 * through one in-process queue rather than a file lock: this service is
 * the file's only writer, single Node process, and a lock would buy
 * nothing a chained promise does not already give for free. A request
 * that arrives while an increment is still in flight simply waits its turn
 * rather than racing it and losing an update.
 */
export function createTrafficCounterStore(dir: string): TrafficCounterStore {
  let queue: Promise<void> = Promise.resolve();
  return {
    increment(slot) {
      const result = queue.then(async () => {
        const path = countPath(dir, slot);
        let current = 0;
        try {
          const text = await readFile(path, 'utf8');
          const parsed = Number.parseInt(text, 10);
          if (Number.isFinite(parsed) && parsed >= 0) current = parsed;
        } catch (err) {
          if (!isEnoent(err)) throw err;
        }
        await writeCountAtomic(path, current + 1);
      });
      // The queue's own tail must never reject -- a failed increment
      // (a real I/O error, not ENOENT) must not wedge every increment
      // after it; the failure still propagates to *this* caller below.
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
}

/** Test/ops helper only: removes a slot's counter file, for a fresh recycle. */
export async function resetTrafficCounter(dir: string, slot: SlotName): Promise<void> {
  await rm(countPath(dir, slot), { force: true });
}
