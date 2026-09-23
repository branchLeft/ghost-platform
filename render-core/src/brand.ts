/**
 * Branded primitives for the tenant descriptor.
 *
 * A branded type carries a phantom tag no plain `string` or `number` has, so
 * TypeScript refuses an unvalidated value in a branded position — the value
 * can only be produced by the matching `validate*` function below, which is
 * the only place the tag is attached. This is a compile-time defence only:
 * data arriving as JSON (over HTTP, from a file) is untyped at the language
 * boundary, so `validate()` in `./validate.ts` re-checks every one of these
 * at runtime rather than trusting the type.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Slug = Brand<string, 'Slug'>;
export type AbsoluteUrl = Brand<string, 'AbsoluteUrl'>;
export type DigestPinnedRef = Brand<string, 'DigestPinnedRef'>;
export type TenantUid = Brand<number, 'TenantUid'>;
export type Port = Brand<number, 'Port'>;
export type PrivateIpV4 = Brand<string, 'PrivateIpV4'>;
/** An ISO-8601 UTC instant, e.g. `2026-09-23T00:00:00.000Z`. */
export type Instant = Brand<string, 'Instant'>;

export class FieldValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(message);
    this.name = 'FieldValidationError';
  }
}

// Slug charset only: whether a given slug is *available* on a host (the
// reserved-name list) is naming.ts's concern in infra/tenant, not this
// package's — a descriptor is valid infrastructure-wide before either
// reconciler asks a specific host whether the name is free.
const SLUG_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const MAX_SLUG_LENGTH = 63;

export function validateSlug(value: string): Slug {
  if (!SLUG_PATTERN.test(value)) {
    throw new FieldValidationError(
      'slug',
      `slug "${value}" must start with a lowercase letter, end with a lowercase letter or ` +
        `digit, and contain only lowercase letters, digits and hyphens in between.`
    );
  }
  if (value.length > MAX_SLUG_LENGTH) {
    throw new FieldValidationError(
      'slug',
      `slug "${value}" is ${value.length} characters; must be at most ${MAX_SLUG_LENGTH}.`
    );
  }
  return value as Slug;
}

export function validateAbsoluteUrl(value: string): AbsoluteUrl {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FieldValidationError('siteUrl', `siteUrl "${value}" is not a valid absolute URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FieldValidationError(
      'siteUrl',
      `siteUrl "${value}" must use http or https, got "${parsed.protocol}".`
    );
  }
  return value as AbsoluteUrl;
}

// A container reference pinned by digest: `<name>[:<tag>]@sha256:<64 hex>`.
// The tag is optional and ignored by the pull — the digest is what makes the
// reference reproducible — but it is allowed here because the estate's own
// pin (`ghost:6.55.0-alpine@sha256:…`) keeps it for a human reading the ref.
const DIGEST_PINNED_PATTERN = /^[a-z0-9][a-z0-9._/-]*(:[\w.-]+)?@sha256:[0-9a-f]{64}$/;

export function validateDigestPinnedRef(value: string): DigestPinnedRef {
  if (!DIGEST_PINNED_PATTERN.test(value)) {
    throw new FieldValidationError(
      'image',
      `image "${value}" must be a digest-pinned reference: "<name>[:<tag>]@sha256:<64 hex ` +
        `characters>". A floating tag with no digest can move under the tenant without a ` +
        `descriptor change.`
    );
  }
  return value as DigestPinnedRef;
}

/** The reserved range a tenant UID must come from — never a real host account's range. */
export const TENANT_UID_MIN = 30000;
export const TENANT_UID_MAX = 30999;

export function validateTenantUid(value: number): TenantUid {
  if (!Number.isInteger(value) || value < TENANT_UID_MIN || value > TENANT_UID_MAX) {
    throw new FieldValidationError(
      'uid',
      `uid ${value} must be an integer in the reserved tenant range ${TENANT_UID_MIN}-` +
        `${TENANT_UID_MAX}.`
    );
  }
  return value as TenantUid;
}

export function validatePort(value: number, field = 'port'): Port {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new FieldValidationError(field, `${field} ${value} must be an integer in 1-65535.`);
  }
  return value as Port;
}

// The estate's private ranges, matched against the address as an integer
// rather than as a string prefix — a prefix check on "172.16." would also
// pass "172.160.0.1", which is not in 172.16.0.0/12 at all.
const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
];

function ipv4ToInt(address: string): number | undefined {
  const octets = address.split('.');
  if (octets.length !== 4) return undefined;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return undefined;
    const part = Number(octet);
    if (part > 255) return undefined;
    // A leading zero is octal to some parsers and decimal to others, so
    // "010.20.1.100" would name two different hosts depending on who reads
    // it — rejected rather than normalised.
    if (octet.length > 1 && octet.startsWith('0')) return undefined;
    value = value * 256 + part;
  }
  return value;
}

export function validatePrivateIpV4(value: string): PrivateIpV4 {
  const asInt = ipv4ToInt(value);
  if (asInt === undefined) {
    throw new FieldValidationError(
      'appHostIp',
      `appHostIp "${value}" is not a dotted-quad IPv4 address.`
    );
  }
  if (!PRIVATE_IPV4_RANGES.some(([low, high]) => asInt >= low && asInt <= high)) {
    throw new FieldValidationError(
      'appHostIp',
      `appHostIp "${value}" is not in a private IPv4 range (10.0.0.0/8, 172.16.0.0/12, ` +
        `192.168.0.0/16).`
    );
  }
  return value as PrivateIpV4;
}

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function validateInstant(value: string, field = 'instant'): Instant {
  if (!INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new FieldValidationError(
      field,
      `${field} "${value}" must be an ISO-8601 UTC instant, e.g. "2026-09-23T00:00:00.000Z".`
    );
  }
  return value as Instant;
}
