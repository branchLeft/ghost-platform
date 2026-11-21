/**
 * Where one tenant's media lives, and Ghost's storage-adapter configuration
 * for it — derived from the descriptor's `media` union alone, never
 * trusting a free-text `bucket` field. See media.md#bucket-derivation.
 */

import type { Slug } from './brand.js';
import { FieldValidationError } from './brand.js';
import type { MediaSpec } from './descriptor.js';

/** Every tenant media bucket carries this prefix — see the ported module's
 * own comment for why a bare slug is not enough (bucket names are
 * account-global, shared with state and backup buckets). */
export const MEDIA_BUCKET_PREFIX = 'branchleft-media-';

export function mediaBucketName(slug: Slug): string {
  return `${MEDIA_BUCKET_PREFIX}${slug}`;
}

/**
 * Refuses a `MediaSpec` s3 `bucket` that disagrees with the slug-derived
 * name — the free-text field must never be trusted, or a descriptor could
 * name another tenant's bucket while still passing shape validation.
 */
export function validateMediaBucket(slug: Slug, media: MediaSpec): void {
  if (media.kind !== 's3') return;
  const expected = mediaBucketName(slug);
  if (media.bucket !== expected) {
    throw new FieldValidationError(
      'media.bucket',
      `media.bucket "${media.bucket}" must be "${expected}", the bucket this slug alone derives ` +
        `— a descriptor may never name another tenant's bucket.`
    );
  }
}

/**
 * The base URL readers load this tenant's media from, and what Ghost writes
 * into every published post as `cdnUrl`. Path-style against the storage
 * host: Hetzner Object Storage has no custom bucket domain to prefer.
 */
export function mediaPublicBaseUrl(endpoint: string, slug: Slug): string {
  if (!endpoint.startsWith('https://')) {
    throw new FieldValidationError(
      'media.endpoint',
      `media.endpoint "${endpoint}" must be https. Ghost embeds this base URL in every published ` +
        `post, so an http endpoint would publish cleartext media URLs no later config change can recall.`
    );
  }
  let end = endpoint.length;
  while (end > 0 && endpoint.charAt(end - 1) === '/') {
    end -= 1;
  }
  const host = endpoint.slice(0, end);
  if (host.slice('https://'.length).includes('/')) {
    throw new FieldValidationError(
      'media.endpoint',
      `media.endpoint "${endpoint}" must be a bare host, with no path — the bucket is the first ` +
        `path segment under it.`
    );
  }
  return `${host}/${mediaBucketName(slug)}`;
}

/**
 * The storage gateway's own folder rule (`services/storage-gateway`,
 * `credentials/admin.ts`): 16 to 128 letters, digits, `_` or `-`. A folder
 * the gateway would refuse to mint a credential for is refused here first.
 */
export const GATEWAY_FOLDER_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The gateway's own bucket rule (`services/storage-gateway`, `router.ts`).
 * A shard is one of the few shared buckets, so its name is checked for shape
 * here and the gateway checks it against the tenant's credential.
 */
const GATEWAY_SHARD_PATTERN = /^(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Refuses a gateway folder that is malformed, or that equals or contains the
 * slug in any letter case. The folder is the tenant's `tenantPrefix`, which
 * Ghost writes into every published media URL, so a folder that names the
 * tenant would tie every published image to that name for good. See
 * media.md#the-tenant-folder.
 */
export function validateMediaFolder(slug: Slug, media: MediaSpec): void {
  if (media.kind !== 'gateway') return;
  const folder = media.folder;
  if (!GATEWAY_FOLDER_PATTERN.test(folder)) {
    throw new FieldValidationError(
      'media.folder',
      `media.folder must be the tenant's opaque random folder: 16 to 128 letters, digits, "_" ` +
        `or "-" (the gateway's own folder rule).`
    );
  }
  if (folder.toLowerCase().includes(slug.toLowerCase())) {
    throw new FieldValidationError(
      'media.folder',
      `media.folder must not equal or contain the slug "${slug}". Ghost writes the folder into ` +
        `every published media URL, so it must be opaque, never the tenant's name.`
    );
  }
}

/**
 * Refuses a gateway shard that is not a well-formed bucket name, that is a
 * per-tenant bucket (`MEDIA_BUCKET_PREFIX`), or that contains the slug: the
 * shards are shared and carry non-identifying names.
 */
export function validateMediaShard(slug: Slug, media: MediaSpec): void {
  if (media.kind !== 'gateway') return;
  const shard = media.shard;
  if (!GATEWAY_SHARD_PATTERN.test(shard)) {
    throw new FieldValidationError(
      'media.shard',
      `media.shard "${shard}" must be a well-formed bucket name (the gateway's own bucket rule).`
    );
  }
  if (shard.startsWith(MEDIA_BUCKET_PREFIX) || shard.includes(slug)) {
    throw new FieldValidationError(
      'media.shard',
      `media.shard "${shard}" must be one of the shared shard buckets: not a per-tenant bucket ` +
        `and not a name that contains the slug "${slug}".`
    );
  }
}

/**
 * Refuses anything but `https://<host>` or `https://<host>:<port>`, with no
 * path, query, fragment or credentials, and returns it without a trailing
 * slash. `field` names the value in the refusal.
 */
export function bareHttpsOrigin(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FieldValidationError(field, `${field} must be an https origin, https://<host>.`);
  }
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') {
    end -= 1;
  }
  const trimmed = value.slice(0, end);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    trimmed !== parsed.origin
  ) {
    throw new FieldValidationError(
      field,
      `${field} "${value}" must be a bare https origin, https://<host>, with no path, query or ` +
        `credentials.`
    );
  }
  return trimmed;
}
