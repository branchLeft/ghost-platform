// RFC 1123 label: 1-63 characters, letters/digits/hyphens, never starting or
// ending on a hyphen. Applied per label rather than as one pattern over the
// whole string so a length violation on one label fails clearly instead of
// as a generic "no match".
const LABEL_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;

/**
 * Whether `value` could syntactically be a DNS hostname at all -- not
 * whether it is one we serve. Run before any lookup so a malformed `domain`
 * value is refused on shape, never on what it happens to collide with in
 * the served set. Caddy's own SNI value is untrusted input arriving as a
 * query parameter (LLD-5 risk tier: "admission control and input parsing").
 */
export function isSyntacticallyValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOSTNAME_LENGTH) {
    return false;
  }
  // A single trailing dot is a valid FQDN spelling; more than one is not.
  const withoutTrailingDot = value.endsWith('.') ? value.slice(0, -1) : value;
  if (withoutTrailingDot.length === 0 || withoutTrailingDot.includes('..')) {
    return false;
  }
  const labels = withoutTrailingDot.split('.');
  return labels.every((label) => LABEL_PATTERN.test(label));
}

/**
 * Hostnames are compared case-insensitively and without a trailing dot --
 * two spellings of the same SNI value must not be able to disagree about
 * membership in the served set.
 */
export function normalizeHostname(value: string): string {
  const lower = value.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

// Deriving which hostname a descriptor is served on -- and which
// descriptors must never reach a per-hostname certificate decision at all
// (a demo's `ours` hostname; a `theirs` fqdn that is itself one of the
// platform's own owned domains; a multi-label `ours` sub) -- is
// render-core's `servedHostnameOf`, imported in descriptorStore.ts rather
// than re-derived here. A second copy of that logic is exactly how it
// diverged the first time: this file used to carry its own version that
// ignored `descriptor.kind` and never checked `sub`'s shape, which
// admitted a demo slot's own hostname into the served set.
