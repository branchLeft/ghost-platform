import type { NonceStore } from './nonceStore.js';
import { verifySignature } from './signing.js';

export interface AuthDeps {
  readonly verifyKey: Buffer;
  readonly replayWindowSeconds: number;
  readonly nonces: NonceStore;
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
 * Checked in this order deliberately: format before the nonce store (a
 * malformed nonce must never be claimed -- an attacker who cannot forge a
 * signature could otherwise still burn legitimate nonces by shape alone),
 * and the nonce claimed only once the timestamp is already inside the
 * window (a claim outside the window, even if reused later at a moment the
 * window would admit it, must not have consumed the one-time claim -- the
 * caller may legitimately retry with a fresh nonce once the window is
 * right). The signature itself is checked last: it is the most expensive
 * check, and every cheaper rejection above should short-circuit before it.
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

  if (!deps.nonces.claim(nonce, deps.nowMs())) {
    return { ok: false, reason: 'nonce already used' };
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
  return { ok: true };
}
