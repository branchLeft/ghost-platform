import { open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';

/**
 * A per-slot count of real reader requests: incremented once for every
 * `verify()` call that ends up admitting the request (a 200, meaning
 * Caddy's `forward_auth` will proxy it on to the slot's own colour pair --
 * LLD-5 §03's placement). This is the one place in the estate that sees
 * every real request to a gated host before it reaches Ghost, which is
 * exactly why `services/broker`'s pre-stop check reads this file rather
 * than anything Ghost or the drain sidecar can report: a sidecar answers
 * for a colour's own health, never for whether a *reader* has actually
 * been admitted, and the falsification clause (LLD-4 §04) is explicit that
 * "reported healthy" must never stand in for that.
 *
 * Colour-blind by construction: this file never learns which colour
 * ultimately serves an admitted request (`$SLOT_UPSTREAM` in the proof
 * Caddyfile is the slot's whole colour pair; Caddy's own `lb_policy first`
 * decides after this check already ran). That is sufficient for
 * `services/broker`'s use of it, not a gap -- at every instant only the
 * slot's one preferred, undrained colour can actually be selected
 * (LLD-4 §U3b: "exactly one flag change moves the traffic"), so a count
 * taken *after* a swap has finished moving traffic is, by that invariant, a
 * count of requests the new colour alone received.
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
