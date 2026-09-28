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
 * What `GET /drain` hands over. Its source (the mail spool, and whatever
 * produces a media-hash record) is a deliberate seam: the long-poll
 * mechanics below are real and proven, but what feeds them is wired in by
 * whichever component owns the spool. See drainSource.md#drainsource.
 */
export interface DrainSource {
  /**
   * Host-wide, not per-slot: each returned item carries its own `slot` so
   * a caller sweeping the whole host in one poll can still attribute what
   * it received. Never rejects on "nothing yet" -- only a genuine failure
   * to reach the underlying source should reject.
   * See drainSource.md#poll.
   */
  poll(signal: AbortSignal): Promise<DrainPayload>;
}
