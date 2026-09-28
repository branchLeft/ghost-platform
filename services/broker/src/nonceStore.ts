/**
 * Replay protection for the signed-request scheme: a timestamp check alone
 * bounds the window a captured request stays valid for, but does not stop
 * it being replayed *within* that window. This store's job is only ever
 * "was this exact nonce claimed already, in this process".
 * See nonceStore.md#noncestore.
 */
export interface NonceStore {
  /** Records `nonce` if unseen within the window; returns false if it was already spent or the store is full. */
  claim(nonce: string, nowMs: number): boolean;
}

/**
 * Generous headroom over realistic traffic to this endpoint, while still
 * bounding memory against an unauthenticated flood of syntactically valid
 * nonces. Claiming happens only after the signature verifies (`auth.ts`),
 * which stops that flood reaching this store at all; this cap is the
 * second, independent layer.
 */
const DEFAULT_MAX_ENTRIES = 100_000;

/**
 * In-memory and per-process. `claim` sweeps only from the map's front
 * (insertion order), relying on a real clock's `nowMs` being
 * non-decreasing so expiry order and insertion order coincide. Fails
 * closed (refuses) once `maxEntries` is reached rather than evicting a
 * live entry to make room. See nonceStore.md#createinmemorynoncestore.
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
