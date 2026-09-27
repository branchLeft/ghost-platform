/**
 * The Ghost version a descriptor *intends*, read from `descriptor.image`
 * rather than stored a second time. `image` is pinned by digest
 * (`brand.ts#validateDigestPinnedRef`); the optional human-readable tag
 * beside the digest — kept, per that validator's own comment, "for a human
 * reading the ref" — is the only place a Ghost version appears anywhere in
 * this schema. LLD-8 §09 needs it for one purpose only: comparing it
 * against what a running Ghost instance reports about itself. That
 * "reported" half never comes from here — LLD-4's mark is explicit that
 * the reported version comes from the instance, never from our own
 * records — so this module knows nothing about probing anything live.
 */

import type { TenantDescriptor } from './descriptor.js';

// The tag, when present, is everything between the name's own trailing `:`
// and the `@` that starts the digest. `validateDigestPinnedRef`'s pattern
// already guarantees the name itself carries no colon and the tag (if any)
// matches `[\w.-]+`, so this extracts a group that pattern already proved
// exists in this shape — it does not re-validate the reference.
const TAG_PATTERN = /^[^@]+:([\w.-]+)@sha256:[0-9a-f]{64}$/;

// Ghost's admin API reports a bare three-part semver ("6.55.0"). The
// estate's own pin also carries a base-image suffix ("-alpine") that Ghost
// never reports about itself, so only the semver prefix of the tag is ever
// comparable to what the instance says.
const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;

/**
 * `null` covers two different, equally honest cases: the image has no tag
 * at all (`validateDigestPinnedRef`'s tag group is optional — a bare
 * `name@sha256:...` is a valid descriptor), or the tag carries no
 * recognisable semver prefix. Callers must treat `null` as "we don't know
 * what this descriptor intends", never as a mismatch — an intent this
 * function cannot read is not evidence the running instance is wrong.
 */
export function intendedGhostVersion(descriptor: TenantDescriptor): string | null {
  const tagMatch = TAG_PATTERN.exec(descriptor.image);
  if (!tagMatch) return null;
  const semverMatch = SEMVER_PREFIX.exec(tagMatch[1]);
  return semverMatch ? semverMatch[0] : null;
}
