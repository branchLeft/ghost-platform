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
 * Checked in this order deliberately:
 *
 * 1. **Format** (timestamp, nonce shape) -- free, and a malformed nonce
 *    must never reach the store below regardless of what else is wrong.
 * 2. **The replay window, including the process-start floor** -- stateless,
 *    no side effect, so checking it before the signature costs nothing and
 *    rejects a stale or replayed-after-restart request before the
 *    expensive step. A timestamp older than `processStartSeconds` is
 *    refused unconditionally: the nonce store is in-memory, so a restart
 *    forgets every nonce it had claimed, and a request captured seconds
 *    before a restart can otherwise still be inside an ordinary window
 *    (default 60s, up to 3600s) once the process comes back.
 * 3. **The signature** -- the only step with real cost, and the one that
 *    actually authenticates the caller.
 * 4. **The nonce claim, last, and only once the signature has verified.**
 *    Claiming first would let anyone -- signed or not -- burn a nonce by
 *    sending its shape with a garbage signature, denying the legitimate
 *    signer the one nonce they meant to use. This ordering is a control in
 *    its own right, proven by sabotage in auth.test.ts: moving the claim
 *    above the signature check turns that regression test red.
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
  // costs a legitimate caller only the process's first second (N1) -- a
  // replay window that would otherwise still admit it.
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
