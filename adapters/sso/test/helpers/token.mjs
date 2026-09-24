// Test-side minter. It follows the envelope the adapter verifies (README.md,
// "Token"): base64url(JSON claims) "." base64url(Ed25519 over the first segment).
import crypto from 'node:crypto';

export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

export function mint(privateKey, claims) {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.sign(null, Buffer.from(body, 'ascii'), privateKey).toString('base64url');
  return `${body}.${signature}`;
}

export function signRaw(privateKey, rawBody) {
  const body = Buffer.from(rawBody, 'utf8').toString('base64url');
  const signature = crypto.sign(null, Buffer.from(body, 'ascii'), privateKey).toString('base64url');
  return `${body}.${signature}`;
}

export function claimsFor({
  sub,
  aud,
  ttlSeconds = 300,
  jti = crypto.randomUUID(),
  nowMs = Date.now(),
}) {
  return { sub, aud, exp: Math.floor(nowMs / 1000) + ttlSeconds, jti };
}
