/**
 * Where one tenant's media lives, derived rather than configured.
 *
 * Each tenant gets its own Object Storage bucket, reached with a credential
 * allowlisted to that bucket alone. Both names are functions of the slug, so a
 * tenant stack has no configurable value that could name another tenant's
 * bucket — the closest thing this platform has to the IAM-condition prefix
 * isolation the GCP shape used, expressed as an absence of choice rather than
 * as a policy the stack has to get right.
 *
 * The same derivation is written a second time, in Python, in
 * `infra/provisioning/scripts/render-media-bucket-policy.py`: that script runs
 * before this component ever sees the tenant, because the bucket has to exist
 * first. The two are kept in step by tests on both sides asserting the same
 * literal strings, the way `naming.ts` and `db/provision/naming.py` already are.
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
 * is the tail of the name. The slug grammar permits a trailing hyphen, so this
 * is refused here rather than assumed away.
 */
const SLUG_LAST_CHARACTER = /[a-z0-9]$/;

/** This tenant's own media bucket. */
export function mediaBucketName(slug: string): string {
  validateTenantSlug(slug);
  if (!SLUG_LAST_CHARACTER.test(slug)) {
    throw new Error(
      `GhostTenant: tenant slug "${slug}" ends in a hyphen, so its media bucket name ` +
        `"${MEDIA_BUCKET_PREFIX}${slug}" would end in one too. S3 requires the last character of a ` +
        `bucket name to be a letter or a digit.`
    );
  }
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
