import type { SlotName } from '@branchleft/ghost-platform-render-core';

export interface QueuedMailItem {
  readonly id: string;
  readonly slot: SlotName;
  readonly envelope: string;
}

export interface MediaHashItem {
  readonly slot: SlotName;
  readonly path: string;
  readonly sha256: string;
}

export interface DrainPayload {
  readonly mail: readonly QueuedMailItem[];
  readonly mediaHashes: readonly MediaHashItem[];
}

export const EMPTY_DRAIN_PAYLOAD: DrainPayload = { mail: [], mediaHashes: [] };

/**
 * What `GET /drain` hands over -- LLD-2 §03 names the payload ("queued mail
 * and media hashes") but not where it comes from. Both are owned by
 * components this story does not build: the mail spool is LLD-6 (still
 * unbuilt; its own "spool never dials out" contract is a different
 * mechanism from this endpoint -- mx1 drains the spool directly over its
 * own connection, per LLD-6 §M5), and nothing yet defines what produces a
 * media-hash record for hand-over. "reaper", named as this endpoint's
 * consumer in LLD-2's own header, is not built either. So this is the same
 * kind of seam as `Renderer`: the long-poll mechanics below are real and
 * proven; what feeds them is wired in by whichever story builds the spool
 * and the reaper.
 */
export interface DrainSource {
  /**
   * Host-wide, not per-slot: LLD-2 §03 gives `/drain` no slot argument (a
   * bare `GET /drain`, unlike `GET /status/<slot>`), and each returned item
   * carries its own `slot` so a caller sweeping the whole host in one poll
   * can still attribute what it received. Resolves once there is something
   * to hand over, or never resolves at all if nothing arrives -- the
   * caller (`app.ts`) races this against its own timeout and aborts
   * `signal` when the poll should give up. Never rejects on "nothing yet";
   * a genuine failure to reach the underlying source should reject so the
   * caller can tell that apart from an empty queue.
   */
  poll(signal: AbortSignal): Promise<DrainPayload>;
}
