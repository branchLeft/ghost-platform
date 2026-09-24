/**
 * Where one tenant's media lives, and Ghost's storage-adapter configuration
 * for it — derived from the descriptor's `media` union alone.
 *
 * Ported and extended from `infra/tenant/media.ts` (LLD-1 §04: "Gains a
 * local-path derivation beside the bucket derivation. Both still derive from
 * the slug alone, which is the isolation control"). The bucket derivation
 * being a pure function of the slug — never a configurable field — is what
 * keeps a descriptor from being able to name another tenant's bucket; see
 * `descriptor.ts`'s `MediaSpec` doc comment and the review comment on
 * workspace#1183 this module resolves: `MediaSpec`'s `s3` variant carries a
 * `bucket` field, so this module derives the expected bucket from the slug
 * and `validateMediaBucket` below refuses a descriptor whose `bucket`
 * disagrees, rather than ever trusting the field's own value.
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
 * name. Carried from the review of PR ghost-platform#226: the free-text
 * field must never be trusted, or a descriptor could name another tenant's
 * bucket while still passing shape validation. Called by `validate()`'s
 * caller-supplied media check would be the natural home, but `validate()`
 * has no `slug`-to-`media` cross-check today (workspace#1224 tracks the
 * general input-hardening pass on `render-core`'s `validate()`); calling it
 * here means `render()` refuses this specific case even before that lands,
 * because the renderer must never emit a stack pointed at a bucket the
 * slug does not own, regardless of which layer catches it first.
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
