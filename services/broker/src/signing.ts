import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

/**
 * Ed25519 keys arrive at this service as 32 raw bytes (`config.ts` refuses
 * anything else), but Node's `crypto` module only imports asymmetric keys
 * from PEM, DER or JWK. These are the fixed ASN.1 prefixes for an
 * unencrypted Ed25519 SubjectPublicKeyInfo / PKCS8 structure -- there is
 * nothing tenant- or request-specific in them, only the raw key bytes vary.
 */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_PRIVATE_KEY_BYTES = 32;

export function publicKeyFromRaw(raw: Buffer) {
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(`Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} raw bytes`);
  }
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Test/tooling only -- the broker itself never holds a private key. */
export function privateKeyFromRaw(raw: Buffer) {
  if (raw.length !== ED25519_PRIVATE_KEY_BYTES) {
    throw new Error(`Ed25519 private key must be ${ED25519_PRIVATE_KEY_BYTES} raw bytes`);
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * The exact bytes a signature covers: method, path, timestamp and nonce as
 * well as the body, so a signed `/reconcile` cannot be replayed unmodified
 * against `/reset`, and the timestamp/nonce a caller signed cannot be
 * swapped for a different pair by a party that only observed the request.
 */
export function signingPayload(
  method: string,
  path: string,
  timestampSeconds: string,
  nonce: string,
  rawBody: Buffer
): Buffer {
  return Buffer.concat([
    Buffer.from(`${method}\n${path}\n${timestampSeconds}\n${nonce}\n`, 'utf8'),
    rawBody,
  ]);
}

export function signRequest(
  privateKeyRaw: Buffer,
  method: string,
  path: string,
  timestampSeconds: string,
  nonce: string,
  rawBody: Buffer
): string {
  const key = privateKeyFromRaw(privateKeyRaw);
  const signature = cryptoSign(
    null,
    signingPayload(method, path, timestampSeconds, nonce, rawBody),
    key
  );
  return signature.toString('base64');
}

export function verifySignature(
  publicKeyRaw: Buffer,
  method: string,
  path: string,
  timestampSeconds: string,
  nonce: string,
  rawBody: Buffer,
  signatureBase64: string
): boolean {
  // `Buffer.from(str, 'base64')` never throws for a string input -- it
  // decodes leniently, dropping characters outside the alphabet -- so the
  // length check below is what actually catches a malformed value.
  const signature = Buffer.from(signatureBase64, 'base64');
  // Ed25519 signatures are always exactly 64 bytes; base64 decoding
  // whitespace or truncated input can otherwise produce a short buffer that
  // some implementations pad rather than refuse.
  if (signature.length !== 64) return false;
  try {
    const key = publicKeyFromRaw(publicKeyRaw);
    return cryptoVerify(
      null,
      signingPayload(method, path, timestampSeconds, nonce, rawBody),
      key,
      signature
    );
  } catch {
    return false;
  }
}
