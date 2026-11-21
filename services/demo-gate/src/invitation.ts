import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/** The emailed arrival link's token: invitation.md. */
export interface InvitationClaims {
  readonly sub: string;
  readonly aud: string;
  readonly host: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export type InvitationRefusal =
  'malformed' | 'signature' | 'claims' | 'expired' | 'lifetime' | 'issued-in-the-future' | 'host';

export type InvitationVerdict =
  | { readonly ok: true; readonly claims: InvitationClaims }
  | { readonly ok: false; readonly reason: InvitationRefusal };

/** The longest a link may live. Matches the adapter's own cap, which refuses anything longer. */
export const MAX_INVITATION_TTL_SECONDS = 900;
/** Allowance for a minter whose clock runs ahead of the gate's. */
export const MAX_ISSUE_SKEW_SECONDS = 60;
export const MAX_INVITATION_LENGTH = 4096;

const MAX_JTI_LENGTH = 128;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The minter's public key as the adapter's configuration holds it; anything else refuses to load. */
export function parseInvitationPublicKey(text: string): KeyObject {
  const compact = text.trim();
  if (!BASE64.test(compact)) {
    throw new Error('the invitation public key is not base64');
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(compact, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new Error('the invitation public key is not an SPKI key');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('the invitation public key is not an Ed25519 key');
  }
  return key;
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Shape, signature, then claims, in the adapter's order. `host` is the request's, lower-cased. */
export function verifyInvitation(
  publicKey: KeyObject,
  token: string,
  host: string,
  nowSeconds: number
): InvitationVerdict {
  if (token.length === 0 || token.length > MAX_INVITATION_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  const [body, signature] = parts;
  if (
    parts.length !== 2 ||
    body === undefined ||
    signature === undefined ||
    !BASE64URL.test(body) ||
    !BASE64URL.test(signature)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const signatureBytes = Buffer.from(signature, 'base64url');
  if (signatureBytes.length !== 64) return { ok: false, reason: 'malformed' };
  if (!verify(null, Buffer.from(body, 'ascii'), publicKey, signatureBytes)) {
    return { ok: false, reason: 'signature' };
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'claims' };
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    return { ok: false, reason: 'claims' };
  }
  const { sub, aud, host: claimedHost, iat, exp, jti } = claims as Record<string, unknown>;
  if (
    !isNonEmptyString(sub, 320) ||
    !isNonEmptyString(aud, 253) ||
    !isNonEmptyString(claimedHost, 253) ||
    !isNonEmptyString(jti, MAX_JTI_LENGTH) ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp)
  ) {
    return { ok: false, reason: 'claims' };
  }
  const issuedAt = iat as number;
  const expiresAt = exp as number;
  if (expiresAt <= nowSeconds) return { ok: false, reason: 'expired' };
  if (issuedAt >= expiresAt) return { ok: false, reason: 'claims' };
  if (expiresAt - issuedAt > MAX_INVITATION_TTL_SECONDS) return { ok: false, reason: 'lifetime' };
  if (expiresAt - nowSeconds > MAX_INVITATION_TTL_SECONDS) return { ok: false, reason: 'lifetime' };
  if (issuedAt > nowSeconds + MAX_ISSUE_SKEW_SECONDS) {
    return { ok: false, reason: 'issued-in-the-future' };
  }
  if (claimedHost.toLowerCase() !== host) return { ok: false, reason: 'host' };
  return { ok: true, claims: { sub, aud, host: claimedHost, iat: issuedAt, exp: expiresAt, jti } };
}
