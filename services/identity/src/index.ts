/** The surface an application imports. `verifyClaims` is deliberately absent:
 * it trusts that the signature was checked, so the only way to a verdict from
 * here is `createTokenVerifier`, which checks it. */
export { createTokenVerifier } from './verifier.js';
export type { Jwk, TokenVerifier, TokenVerifierOptions } from './verifier.js';
export type { Verdict } from './tokens.js';
export { CLAIM_PROJECT_ROLES, CLAIM_RESOURCE_OWNER } from './tokens.js';
export { ROLE_OWNER, ROLE_TENANT_ADMIN } from './desired.js';
