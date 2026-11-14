/** What {@link ReplayGuard.claim} decided about one signature. */
export type ReplayClaim =
  /** First sighting inside the window: the request may go on, and the signature is now spent. */
  | 'claimed'
  /** Already spent and not yet expired: the same signed request is being sent again. */
  | 'replayed'
  /** The table is at its bound. A live entry is never evicted, so the caller must refuse. */
  | 'full';

/**
 * Remembers every accepted signature until the request that carried it can no
 * longer pass the clock check, so a captured request cannot be sent twice.
 */
export interface ReplayGuard {
  /**
   * The signature covers the key id, date, method, path, query and payload
   * hash, so it identifies one signed request. It is remembered until
   * `requestTimeMs` plus the guard's window, whatever the clock then says.
   */
  claim(signature: string, requestTimeMs: number, nowMs: number): ReplayClaim;
  /**
   * Gives a claim back. Only for a request that holds the claim and was
   * answered "try again" without taking effect, so its honest retry, signed
   * in the same second and so byte for byte the same, is not refused.
   */
  release(signature: string): void;
}

export const DEFAULT_REPLAY_GUARD_LIMIT = 50_000;
/** Slack after the window for a request dated at the very edge of it. */
const EXPIRY_MARGIN_MS = 1000;

export interface ReplayGuardOptions {
  /** The verifier's clock window: how far from now a request's date may be, either way. */
  readonly windowMs: number;
  /** Most signatures remembered at once. Defaults to {@link DEFAULT_REPLAY_GUARD_LIMIT}. */
  readonly limit?: number;
}

/**
 * In memory and bounded, per process, which is how the gateway already holds
 * its upload bindings; a restart forgets every signature, so a captured
 * request can be sent once more for at most one window after it. At the bound
 * a claim is refused and nothing is evicted, since eviction would reopen
 * replay. An entry lives until the second its request expires, and entries
 * are grouped by that second, so expiry drops whole groups and a claim does
 * not scan the table.
 */
export function createInMemoryReplayGuard(options: ReplayGuardOptions): ReplayGuard {
  const { windowMs } = options;
  const limit = options.limit ?? DEFAULT_REPLAY_GUARD_LIMIT;
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new RangeError('windowMs must be a finite, non-negative number');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive whole number');
  }
  /** signature -> the second its entry expires. */
  const expiry = new Map<string, number>();
  /** expiry second -> the signatures that expire in it. */
  const groups = new Map<number, Set<string>>();
  let sweptSecond = Number.NEGATIVE_INFINITY;

  const sweep = (nowMs: number): void => {
    const second = Math.floor(nowMs / 1000);
    if (second === sweptSecond) return;
    sweptSecond = second;
    for (const [group, signatures] of groups) {
      if (group > second) continue;
      for (const signature of signatures) expiry.delete(signature);
      groups.delete(group);
    }
  };

  return {
    claim(signature, requestTimeMs, nowMs) {
      sweep(nowMs);
      // An entry from a second ago may still be listed: expired is not spent.
      const known = expiry.get(signature);
      if (known !== undefined && known > Math.floor(nowMs / 1000)) return 'replayed';
      if (known === undefined && expiry.size >= limit) return 'full';
      const second = Math.floor((requestTimeMs + windowMs + EXPIRY_MARGIN_MS) / 1000);
      // A request already past its expiry cannot be replayed either: nothing to remember.
      if (second <= Math.floor(nowMs / 1000)) return 'claimed';
      if (known !== undefined) groups.get(known)?.delete(signature);
      expiry.set(signature, second);
      const group = groups.get(second) ?? new Set<string>();
      group.add(signature);
      groups.set(second, group);
      return 'claimed';
    },
    release(signature) {
      const known = expiry.get(signature);
      if (known === undefined) return;
      expiry.delete(signature);
      const group = groups.get(known);
      group?.delete(signature);
      if (group?.size === 0) groups.delete(known);
    },
  };
}
