import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Time-bounded links to one tenant's media. The storage gateway refuses
 * presigned requests and a tenant holds no storage key, so these are not
 * S3 presigns: they are HMAC tokens that our own export-download route
 * verifies with the same shared secret, using `verifyMediaLink`.
 *
 * The signature binds the tenant, the object key and the expiry, so a link
 * for one tenant's object cannot be replayed for another tenant's, and
 * moving the expiry invalidates it.
 */

export const LINK_VERSION = 'v1';
export const MIN_SECRET_BYTES = 32;
export const MAX_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MIN_LINK_TTL_SECONDS = 60;

export class MediaLinkError extends Error {
  constructor(
    readonly reason:
      | 'weak-secret'
      | 'bad-ttl'
      | 'bad-base-url'
      | 'bad-key'
      | 'malformed'
      | 'bad-signature'
      | 'expired'
      | 'wrong-tenant',
    message: string
  ) {
    super(message);
    this.name = 'MediaLinkError';
  }
}

export interface MediaLinkSigner {
  readonly baseUrl: string;
  readonly ttlSeconds: number;
  readonly secret: Buffer;
}

export interface VerifiedMediaLink {
  readonly tenantId: string;
  readonly key: string;
  readonly expiresAt: number;
}

const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A relative object key: no empty, dot or encoded-dot segments, no backslash, no control byte. */
export function assertSafeObjectKey(key: string): void {
  const segments = key.split('/');
  const bad =
    key.length === 0 ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f?#]/.test(key) ||
    segments.some((s) => s === '' || s === '.' || s === '..' || /^(%2e)+$/i.test(s)) ||
    /%2f|%5c/i.test(key);
  if (bad) throw new MediaLinkError('bad-key', `unsafe media object key: ${JSON.stringify(key)}`);
}

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID.test(tenantId)) {
    throw new MediaLinkError('malformed', `not a tenant id: ${JSON.stringify(tenantId)}`);
  }
}

function mac(secret: Buffer, tenantId: string, key: string, expires: number): Buffer {
  return createHmac('sha256', secret)
    .update(`${LINK_VERSION}\n${tenantId}\n${key}\n${expires}`)
    .digest();
}

export function assertSigner(signer: MediaLinkSigner): void {
  if (signer.secret.length < MIN_SECRET_BYTES) {
    throw new MediaLinkError(
      'weak-secret',
      `the link secret must be at least ${MIN_SECRET_BYTES} bytes`
    );
  }
  if (
    !Number.isInteger(signer.ttlSeconds) ||
    signer.ttlSeconds < MIN_LINK_TTL_SECONDS ||
    signer.ttlSeconds > MAX_LINK_TTL_SECONDS
  ) {
    throw new MediaLinkError(
      'bad-ttl',
      `the link lifetime must be ${MIN_LINK_TTL_SECONDS}..${MAX_LINK_TTL_SECONDS} seconds`
    );
  }
  let url: URL;
  try {
    url = new URL(signer.baseUrl);
  } catch {
    throw new MediaLinkError('bad-base-url', 'the link base URL is not a URL');
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new MediaLinkError('bad-base-url', 'the link base URL must be a bare https origin');
  }
}

export interface SignedLink {
  readonly url: string;
  readonly expiresAt: number;
}

/** `nowSeconds` is passed in so a test clock decides expiry, never the wall clock. */
export function signMediaLink(
  signer: MediaLinkSigner,
  tenantId: string,
  key: string,
  nowSeconds: number
): SignedLink {
  assertSigner(signer);
  assertTenantId(tenantId);
  assertSafeObjectKey(key);
  const expiresAt = Math.floor(nowSeconds) + signer.ttlSeconds;
  const sig = mac(signer.secret, tenantId, key, expiresAt).toString('hex');
  const base = signer.baseUrl.replace(/\/+$/, '');
  const path = key.split('/').map(encodeURIComponent).join('/');
  return { url: `${base}/${tenantId}/${path}?expires=${expiresAt}&sig=${sig}`, expiresAt };
}

/**
 * What the download route runs. Throws `MediaLinkError`; returns the tenant
 * and key only for a link that is intact, unexpired and, when
 * `expectedTenantId` is given, for that tenant.
 */
export function verifyMediaLink(
  secret: Buffer,
  link: string,
  nowSeconds: number,
  expectedTenantId?: string
): VerifiedMediaLink {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new MediaLinkError('malformed', 'the link is not a URL');
  }
  const expiresRaw = url.searchParams.get('expires');
  const sigRaw = url.searchParams.get('sig');
  if (!expiresRaw || !/^\d{1,12}$/.test(expiresRaw) || !sigRaw || !/^[0-9a-f]{64}$/.test(sigRaw)) {
    throw new MediaLinkError('malformed', 'the link has no valid expires and sig');
  }
  const parts = url.pathname.split('/').filter((_, i) => i > 0);
  const tenantId = parts[0] ?? '';
  if (parts.length < 2)
    throw new MediaLinkError('malformed', 'the link path has no tenant and key');
  let key: string;
  try {
    key = parts.slice(1).map(decodeURIComponent).join('/');
    assertTenantId(tenantId);
    assertSafeObjectKey(key);
  } catch (err) {
    if (err instanceof MediaLinkError) throw err;
    throw new MediaLinkError('malformed', 'the link path is not decodable');
  }
  const expires = Number(expiresRaw);
  const expected = mac(secret, tenantId, key, expires);
  const given = Buffer.from(sigRaw, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new MediaLinkError('bad-signature', 'the link signature does not match');
  }
  if (nowSeconds >= expires) throw new MediaLinkError('expired', 'the link has expired');
  if (expectedTenantId !== undefined && expectedTenantId !== tenantId) {
    throw new MediaLinkError('wrong-tenant', 'the link was issued for another tenant');
  }
  return { tenantId, key, expiresAt: expires };
}
