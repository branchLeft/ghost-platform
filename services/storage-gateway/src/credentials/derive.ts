import { hkdfSync } from 'node:crypto';
import type { MasterSecret } from './masterSecret.js';

/**
 * The domain-separation label for tenant SigV4 secrets. It is the leading
 * part of HKDF's `info`, so a secret derived for this purpose can never
 * equal one derived from the same master secret for any other purpose.
 * Changing it changes every tenant's secret: it is versioned, never edited.
 */
export const TENANT_SECRET_LABEL = 'branchleft/storage-gateway/tenant-sigv4-secret/v1';

/** Bytes of HKDF output per tenant secret: SHA-256's hash length. */
export const TENANT_SECRET_BYTES = 32;

/**
 * Key ids are upper-case letters and digits, as SigV4 access key ids are.
 * The bound keeps the id usable as a SQL key and in a credential scope, and
 * rules out the separator byte used in `info` below.
 */
export const KEY_ID_PATTERN = /^[A-Z0-9]{16,64}$/;

export function isValidKeyId(keyId: string): boolean {
  return KEY_ID_PATTERN.test(keyId);
}

/** HKDF-SHA256 (RFC 5869): extract with `salt`, then expand with `info` to `length` bytes. */
export function hkdfSha256(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * The HKDF `info` for one key id: the label, a zero byte, then the key id.
 * The zero byte cannot occur in either part, so no (label, key id) pair
 * encodes the same bytes as another.
 */
export function tenantSecretInfo(keyId: string): Buffer {
  return Buffer.concat([
    Buffer.from(TENANT_SECRET_LABEL, 'utf8'),
    Buffer.from([0]),
    Buffer.from(keyId, 'utf8'),
  ]);
}

/**
 * Derives a tenant's SigV4 secret access key from the master secret and the
 * key id, as unpadded base64url text. Deterministic: the same key id always
 * gives the same secret, which is why a key id must never be issued twice.
 * The salt is empty (RFC 5869 then uses a hash-length string of zeros)
 * because the master secret is already uniformly random; the label in
 * `info` does the separating.
 */
export function deriveTenantSecret(master: MasterSecret, keyId: string): string {
  if (!isValidKeyId(keyId)) {
    throw new Error('key id is not well formed');
  }
  const okm = hkdfSha256(
    master.keyMaterial(),
    Buffer.alloc(0),
    tenantSecretInfo(keyId),
    TENANT_SECRET_BYTES
  );
  return okm.toString('base64url');
}
