export interface DeliveredTracker {
  has(id: string): boolean;
  markDelivered(id: string): void;
  /** Drops entries older than the configured TTL. Called on a timer by the caller, not internally, so tests can drive it deterministically. */
  sweep(): void;
  readonly size: number;
}

/**
 * What turns the shim's documented at-least-once drain (routes/drain.ts: a
 * lease that lapses before an ack is re-offered "to this drainer again or
 * to another one") into exactly-once delivery at the sink. A message id is
 * stable across re-offers (the shim's own contract), so remembering which
 * ids this process has already handed to the delivery host is enough: a
 * re-offer caused by a lost ack is recognised here and skipped, not
 * redelivered -- only re-acked, to finally clear it from the shim's queue.
 *
 * Bounded by a TTL rather than kept forever, so a long-running process does
 * not accumulate one entry per message ever sent. The TTL only needs to
 * outlast the window in which a re-offer of the SAME id can plausibly still
 * arrive (bounded by the shim's lease length plus however long an ack can
 * stay lost); the default in config.ts is an hour, comfortably past that.
 */
export function createDeliveredTracker(
  ttlMs: number,
  now: () => number = Date.now
): DeliveredTracker {
  const deliveredAt = new Map<string, number>();

  return {
    has(id: string): boolean {
      return deliveredAt.has(id);
    },
    markDelivered(id: string): void {
      deliveredAt.set(id, now());
    },
    sweep(): void {
      const cutoff = now() - ttlMs;
      for (const [id, at] of deliveredAt) {
        if (at < cutoff) {
          deliveredAt.delete(id);
        }
      }
    },
    get size(): number {
      return deliveredAt.size;
    },
  };
}
