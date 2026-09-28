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
