/**
 * Where one tenant's media lives, derived rather than configured: both names
 * are functions of the slug, so a tenant stack has no configurable value
 * that could name another tenant's bucket. See media.md#where-one-tenants-media-lives-derived-rather-than-configured.
 */

import { validateTenantSlug } from './naming';

/**
 * Every tenant media bucket carries this prefix.
 *
 * It is not decoration: Object Storage buckets are account-global and shared
 * with the state buckets and the backup targets, so a prefix is what keeps a
 * tenant slug from colliding with an estate bucket of the same name.
 */
export const MEDIA_BUCKET_PREFIX = 'branchleft-media-';

/**
 * S3 requires a bucket name's last character to be alphanumeric, and the slug
 * is the tail of the name. `validateTenantSlug` enforces that same
 * start/end-alphanumeric rule on the slug grammar itself, so a slug that
 * reaches this line can never end in a hyphen — there is nothing left for
 * this function to check on its own.
 */
export function mediaBucketName(slug: string): string {
  validateTenantSlug(slug);
  return `${MEDIA_BUCKET_PREFIX}${slug}`;
}

/**
 * The base URL readers load this tenant's media from, and what Ghost writes
 * into every published post as `cdnUrl`.
 *
 * Path-style against the storage host, because Hetzner Object Storage does not
 * support custom bucket domains — there is no branded alternative to reject
 * here. Changing this value later rewrites nothing already published, which is
 * why the shape is derived from the tenant's own bucket and not from a
 * platform-wide constant somebody can edit.
 */
export function mediaPublicBaseUrl(endpoint: string, slug: string): string {
  if (!endpoint.startsWith('https://')) {
    throw new Error(
      `GhostTenant: media endpoint "${endpoint}" must be https. Ghost embeds this base URL in every ` +
        `published post, so an http endpoint would publish cleartext media URLs that no later config ` +
        `change can recall.`
    );
  }
  // Trailing slashes are trimmed by index rather than by `/\/+$/`, which is a
  // polynomial-backtracking pattern on a string of many slashes.
  let end = endpoint.length;
  while (end > 0 && endpoint.charAt(end - 1) === '/') {
    end -= 1;
  }
  const host = endpoint.slice(0, end);
  if (host.slice('https://'.length).includes('/')) {
    throw new Error(
      `GhostTenant: media endpoint "${endpoint}" must be a bare host, with no path. The bucket is ` +
        `the first path segment under it.`
    );
  }
  return `${host}/${mediaBucketName(slug)}`;
}
