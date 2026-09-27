import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';

/**
 * "As the administrator" turns out to mean literally that: Ghost's own
 * permission model (verified against a real container, not assumed)
 * refuses `db.exportContent` and `posts.exportCSV` to a custom
 * integration's Admin API key -- both answer 403 `NoPermissionError`,
 * because "Export database" is not among the permissions the "Admin
 * Integration" role carries. Only a staff session with the Administrator
 * or Owner role can call either route.
 *
 * `adapters/sso/README.md`'s break-glass adapter is this platform's own
 * mechanism for exactly that: "an operator holding a short-lived signed
 * token open[ing] an Administrator session as one account fixed per site,
 * with no standing password anywhere" -- built for support access
 * (LLD-5 §05) and reused here because LLD-8 §08b frames an export as
 * carrying "the same weight as a support grant". This mints the same
 * token `adapters/sso/src/break-glass.js` verifies; it is not a second,
 * parallel scheme.
 */
export interface BreakGlassMinter {
  mint(): string;
}

// Mirrors services/broker/src/signing.ts's own reasoning for wrapping a
// raw Ed25519 key: Node's crypto module only imports asymmetric keys from
// PEM, DER or JWK, and this is the fixed ASN.1 prefix for an unencrypted
// Ed25519 PKCS8 structure.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const ED25519_PRIVATE_KEY_BYTES = 32;

function privateKeyFromRaw(raw: Buffer) {
  if (raw.length !== ED25519_PRIVATE_KEY_BYTES) {
    throw new Error(`break-glass private key must be ${ED25519_PRIVATE_KEY_BYTES} raw bytes`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * `ttlSeconds` defaults to 60 -- this token is used once, immediately, by
 * the same process that minted it, never carried to a browser or a third
 * party, so it needs none of the margin break-glass.js's own README gives
 * a human-delivered link. `randomJti` defaults to 128 random bits, matching
 * the adapter's own comment on what "unpredictable" means here.
 */
export function createBreakGlassMinter(
  privateKeyRaw: Buffer,
  tenant: string,
  supportIdentity: string,
  ttlSeconds = 60,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  randomJti: () => string = () => randomBytes(16).toString('base64url')
): BreakGlassMinter {
  const privateKey = privateKeyFromRaw(privateKeyRaw);
  return {
    mint() {
      const iat = nowSeconds();
      const claims = {
        sub: supportIdentity,
        aud: tenant,
        iat,
        exp: iat + ttlSeconds,
        jti: randomJti(),
      };
      const body = base64url(Buffer.from(JSON.stringify(claims)));
      // Ed25519 signs the exact ASCII bytes of the encoded body, matching
      // break-glass.js's own verification
      // (`crypto.verify(null, Buffer.from(body, 'ascii'), key, sig)`).
      const signature = cryptoSign(null, Buffer.from(body, 'ascii'), privateKey);
      return `${body}.${base64url(signature)}`;
    },
  };
}
