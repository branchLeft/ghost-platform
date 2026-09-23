import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';

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

/**
 * The fully-qualified hostname a descriptor is served on. `ours` composes
 * with this edge's own base domain (a deployment property, not a descriptor
 * field -- see `AskConfig.baseDomain`); `theirs` already carries the full
 * name. Demo slots (platform-wildcard, LLD-5 E4) never reach this function:
 * they are certificated once, off the descriptor set this endpoint reads.
 */
export function servedHostnameOf(descriptor: TenantDescriptor, baseDomain: string): string {
  const hostname = descriptor.hostname;
  if (hostname.kind === 'theirs') {
    return normalizeHostname(hostname.fqdn);
  }
  return normalizeHostname(`${hostname.sub}.${baseDomain}`);
}
