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
export const FORWARD_SKEW_SECONDS = 5;

/**
 * How long a spent nonce must be remembered. The timestamp check admits a
 * request from FORWARD_SKEW_SECONDS before its timestamp until the end of
 * the second `timestamp + replayWindowSeconds`, so the nonce has to
 * outlive that whole span; remembering it for the window alone lets a
 * captured request be replayed once the nonce is forgotten.
 */
export function nonceLifetimeMs(replayWindowSeconds: number): number {
  return (replayWindowSeconds + FORWARD_SKEW_SECONDS + 1) * 1000;
}

/**
 * Why a request was refused, as a fixed code. A process other than the broker
 * (the verdict host) takes these as its metric labels, so a code is a
 * contract: add one only together with its consumers.
 */
export type AuthRefusal =
  'timestamp' | 'nonce' | 'signature-missing' | 'window' | 'before-start' | 'signature' | 'replay';

export type AuthCheck = { readonly ok: true } | { readonly ok: false; readonly code: AuthRefusal };

const REFUSAL_REASONS: Readonly<Record<AuthRefusal, string>> = {
  timestamp: 'missing or malformed timestamp',
  nonce: 'missing or malformed nonce',
  'signature-missing': 'missing signature',
  window: 'timestamp outside the replay window',
  'before-start': 'timestamp predates this process (replayed after a restart)',
  signature: 'signature does not verify',
  replay: 'nonce already used',
};

/**
 * Checks run in this order deliberately: format, then the replay window
 * (cheapest, and rejects a stale/replayed-after-restart request early),
 * then the signature, and only last, once verified, the nonce claim --
 * claiming first would let an unsigned request burn the legitimate
 * signer's nonce. See auth.md#verifyrequest-check-order.
 *
 * This is the one place the order lives. The broker answers with
 * `verifyRequest` below; the verdict host builds this same function into
 * its bundle (`signedRequestScheme.ts`) and answers with the code.
 */
export function checkRequest(
  deps: AuthDeps,
  method: string,
  path: string,
  headers: { readonly timestamp?: string; readonly nonce?: string; readonly signature?: string },
  rawBody: Buffer
): AuthCheck {
  const { timestamp, nonce, signature } = headers;
  if (!timestamp || !TIMESTAMP_PATTERN.test(timestamp)) {
    return { ok: false, code: 'timestamp' };
  }
  if (!nonce || !NONCE_PATTERN.test(nonce)) {
    return { ok: false, code: 'nonce' };
  }
  if (!signature) {
    return { ok: false, code: 'signature-missing' };
  }

  // One reading of the clock per request: the window and the nonce's expiry
  // are measured from the same instant.
  const nowMs = deps.nowMs();
  const nowSeconds = Math.floor(nowMs / 1000);
  const requestSeconds = Number(timestamp);
  const ageSeconds = nowSeconds - requestSeconds;
  if (ageSeconds > deps.replayWindowSeconds || ageSeconds < -FORWARD_SKEW_SECONDS) {
    return { ok: false, code: 'window' };
  }
  // `<=`, not `<`: a request captured, then replayed after a crash and
  // restart that both land inside the same wall-clock second, has a
  // timestamp exactly equal to `processStartSeconds`. Refusing that too
  // costs a legitimate caller only the process's first second -- a replay
  // window that would otherwise still admit it.
  if (requestSeconds <= deps.processStartSeconds) {
    return { ok: false, code: 'before-start' };
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
    return { ok: false, code: 'signature' };
  }

  if (!deps.nonces.claim(nonce, nowMs)) {
    return { ok: false, code: 'replay' };
  }
  return { ok: true };
}

/** `checkRequest`, with the broker's own words for the refusal. */
export function verifyRequest(
  deps: AuthDeps,
  method: string,
  path: string,
  headers: { readonly timestamp?: string; readonly nonce?: string; readonly signature?: string },
  rawBody: Buffer
): AuthResult {
  const checked = checkRequest(deps, method, path, headers, rawBody);
  return checked.ok ? checked : { ok: false, reason: REFUSAL_REASONS[checked.code] };
}
