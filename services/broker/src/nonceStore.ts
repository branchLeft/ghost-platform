/**
 * Replay protection for the signed-request scheme: a signature covers a
 * timestamp and a nonce (LLD-2 §03), so a captured request is only
 * unreplayable if something actually remembers which nonces have been
 * spent. A timestamp check alone bounds the window a captured request stays
 * valid for; it does not stop it being replayed *within* that window, and
 * on its own it does not survive a broker restart either -- a fresh,
 * in-memory store (this one) forgets every nonce it had claimed, so a
 * captured request from seconds before a restart is still inside the
 * window and would otherwise be admitted again. `auth.ts` closes that gap
 * with a separate, process-start check; this store's job is only ever
 * "was this exact nonce claimed already, in this process".
 */
export interface NonceStore {
  /** Records `nonce` if unseen within the window; returns false if it was already spent or the store is full. */
  claim(nonce: string, nowMs: number): boolean;
}

/**
 * Generous headroom over realistic traffic to this endpoint (four signed
 * requests, no public exposure), while still bounding memory against an
 * unauthenticated flood of syntactically valid nonces -- see F4's finding:
 * claiming must happen only after the signature verifies (`auth.ts`), which
 * is what stops that flood from ever reaching this store in the first
 * place; this cap is the second, independent layer.
 */
const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * In-memory and per-process. `claim` sweeps only from the front of the map
 * -- insertion order -- stopping at the first entry that has not yet
 * expired, rather than scanning every entry on every call: a real clock's
 * `nowMs` is non-decreasing across calls, so expiry order and insertion
 * order coincide and the front is exactly where expired entries
 * accumulate. Bounded by `maxEntries` regardless, so a flood of syntactically
 * valid, differently-nonced requests cannot grow this store without limit
 * even if that assumption is ever violated -- `claim` fails closed (refuses)
 * once full rather than evicting a live entry to make room.
 */
export function createInMemoryNonceStore(
  windowMs: number,
  maxEntries = DEFAULT_MAX_ENTRIES
): NonceStore {
  const seen = new Map<string, number>();
  return {
    claim(nonce, nowMs) {
      for (const [key, expiresAtMs] of seen) {
        if (expiresAtMs > nowMs) break;
        seen.delete(key);
      }
      if (seen.has(nonce)) return false;
      if (seen.size >= maxEntries) return false;
      seen.set(nonce, nowMs + windowMs);
      return true;
    },
  };
}
