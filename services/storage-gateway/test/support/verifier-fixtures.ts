import type { GatewayRequest, TenantSecretSource } from '../../src/contracts.js';
import { SigV4Verifier, type SigV4VerifierOptions } from '../../src/sigv4-verifier.js';
import type { SignerIdentity } from './reference-signer.js';

export const KEY_ID = 'GWTENANTKEY0001';
export const SECRET = 'TEST_ONLY_SECRET/with+base64=chars';
export const OTHER_KEY_ID = 'GWTENANTKEY0002';
export const OTHER_SECRET = 'TEST_ONLY_OTHER_SECRET';
export const REGION = 'nbg1';
export const SIGNING_DATE = new Date('2026-10-06T09:30:15Z');

export const IDENTITY: SignerIdentity = {
  keyId: KEY_ID,
  secret: SECRET,
  region: REGION,
  signingDate: SIGNING_DATE,
};

/** A test double for the key-derivation source: a fixed table of two tenants. */
export function secretTable(
  table: Readonly<Record<string, string>> = { [KEY_ID]: SECRET, [OTHER_KEY_ID]: OTHER_SECRET }
): TenantSecretSource {
  return { secretFor: (keyId) => Promise.resolve(table[keyId]) };
}

export function makeVerifier(overrides: Partial<SigV4VerifierOptions> = {}): SigV4Verifier {
  return new SigV4Verifier({
    region: REGION,
    secrets: secretTable(),
    now: () => SIGNING_DATE.getTime(),
    ...overrides,
  });
}

/** A copy of a request with some headers replaced, or removed with `undefined`. */
export function withHeaders(
  request: GatewayRequest,
  changes: Readonly<Record<string, string | readonly string[] | undefined>>
): GatewayRequest {
  return { ...request, headers: { ...request.headers, ...changes } };
}

/** The Authorization header of a signed request, as a string. */
export function authOf(request: GatewayRequest): string {
  const a = request.headers.authorization;
  if (typeof a !== 'string') throw new Error('expected one authorization header');
  return a;
}

export function withAuth(request: GatewayRequest, authorization: string): GatewayRequest {
  return withHeaders(request, { authorization });
}
