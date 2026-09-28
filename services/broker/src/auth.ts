import type { NonceStore } from './nonceStore.js';
import { verifySignature } from './signing.js';

export interface AuthDeps {
  readonly verifyKey: Buffer;
  readonly replayWindowSeconds: number;
  readonly nonces: NonceStore;
  /** See `config.ts`: captured once at process start, never from a request. */
  readonly processStartSeconds: number;
  readonly nowMs: () => number;
}

export type AuthResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const NONCE_PATTERN = /^[A-Za-z0-9._-]{16,128}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,20}$/;
// A signature ahead of "now" is allowed by exactly this much, to absorb
// ordinary clock drift between the caller and this host -- never more,
// because every second of forward slack is a second a captured request
// stays valid for again once the window has otherwise elapsed.
const FORWARD_SKEW_SECONDS = 5;

/**
 * Checks run in this order deliberately: format, then the replay window
 * (cheapest, and rejects a stale/replayed-after-restart request early),
 * then the signature, and only last, once verified, the nonce claim --
 * claiming first would let an unsigned request burn the legitimate
 * signer's nonce. See auth.md#verifyrequest-check-order.
 */
export function verifyRequest(
  deps: AuthDeps,
  method: string,
  path: string,
  headers: { readonly timestamp?: string; readonly nonce?: string; readonly signature?: string },
  rawBody: Buffer
): AuthResult {
  const { timestamp, nonce, signature } = headers;
  if (!timestamp || !TIMESTAMP_PATTERN.test(timestamp)) {
    return { ok: false, reason: 'missing or malformed timestamp' };
  }
  if (!nonce || !NONCE_PATTERN.test(nonce)) {
    return { ok: false, reason: 'missing or malformed nonce' };
  }
  if (!signature) {
    return { ok: false, reason: 'missing signature' };
  }

  const nowSeconds = Math.floor(deps.nowMs() / 1000);
  const requestSeconds = Number(timestamp);
  const ageSeconds = nowSeconds - requestSeconds;
  if (ageSeconds > deps.replayWindowSeconds || ageSeconds < -FORWARD_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp outside the replay window' };
  }
  // `<=`, not `<`: a request captured, then replayed after a crash and
  // restart that both land inside the same wall-clock second, has a
  // timestamp exactly equal to `processStartSeconds`. Refusing that too
  // costs a legitimate caller only the process's first second -- a replay
  // window that would otherwise still admit it.
  if (requestSeconds <= deps.processStartSeconds) {
    return { ok: false, reason: 'timestamp predates this process (replayed after a restart)' };
  }

  const verified = verifySignature(
    deps.verifyKey,
    method,
    path,
    timestamp,
    nonce,
    rawBody,
    signature
  );
  if (!verified) {
    return { ok: false, reason: 'signature does not verify' };
  }

  if (!deps.nonces.claim(nonce, deps.nowMs())) {
    return { ok: false, reason: 'nonce already used' };
  }
  return { ok: true };
}
