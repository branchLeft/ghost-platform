/**
 * Replay protection for the signed-request scheme: a signature covers a
 * timestamp and a nonce (LLD-2 §03), so a captured request is only
 * unreplayable if something actually remembers which nonces have been
 * spent. A timestamp check alone bounds the window a captured request stays
 * valid for; it does not stop it being replayed *within* that window.
 */
export interface NonceStore {
  /** Records `nonce` if unseen within the window; returns false if it was already spent. */
  claim(nonce: string, nowMs: number): boolean;
}

interface Entry {
  readonly expiresAtMs: number;
}

/**
 * In-memory and per-process, which is sufficient for the property it
 * guarantees: a nonce is spent for as long as the timestamp window that
 * would otherwise admit it stays open, and a process restart is itself a
 * discontinuity a replayed old timestamp would fail on anyway (the window
 * check runs first). Swept lazily on `claim` rather than on a timer, so an
 * idle process holds no background work.
 */
export function createInMemoryNonceStore(windowMs: number): NonceStore {
  const seen = new Map<string, Entry>();
  return {
    claim(nonce, nowMs) {
      for (const [key, entry] of seen) {
        if (entry.expiresAtMs <= nowMs) seen.delete(key);
      }
      if (seen.has(nonce)) return false;
      seen.set(nonce, { expiresAtMs: nowMs + windowMs });
      return true;
    },
  };
}
