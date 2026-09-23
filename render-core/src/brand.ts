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
export type EmailAddress = Brand<string, 'EmailAddress'>;

export class FieldValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(message);
    this.name = 'FieldValidationError';
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return typeof value;
}

/**
 * Every validator below assumes the language type its parameter declares.
 * That is a compile-time promise only — a value arriving as parsed JSON can
 * be anything — so each one checks its own type first, rather than letting
 * a later `.length`/`.split`/`.trim()` throw a raw `TypeError` that names no
 * field.
 */
export function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new FieldValidationError(field, `${field} must be a string, got ${describeType(value)}.`);
  }
}

export function assertNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new FieldValidationError(field, `${field} must be a number, got ${describeType(value)}.`);
  }
}

// Slug charset only: whether a given slug is *available* on a host (the
// reserved-name list) is naming.ts's concern in infra/tenant, not this
// package's — a descriptor is valid infrastructure-wide before either
// reconciler asks a specific host whether the name is free.
const SLUG_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const MAX_SLUG_LENGTH = 63;

export function validateSlug(value: string): Slug {
  assertString(value, 'slug');
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
  assertString(value, 'siteUrl');
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
  assertString(value, 'image');
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
  assertNumber(value, 'uid');
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
  assertNumber(value, field);
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
  assertString(value, 'appHostIp');
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
  assertString(value, field);
  if (!INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new FieldValidationError(
      field,
      `${field} "${value}" must be an ISO-8601 UTC instant, e.g. "2026-09-23T00:00:00.000Z".`
    );
  }
  return value as Instant;
}

// RFC 5321 §4.5.3.1.3's overall path-length limit, checked before any regex
// touches the value: a prior version of this function matched an unbounded
// value against a pattern with two adjacent `[^\s@]+` groups either side of
// a literal, which — on an input with no `@` or no `.` — makes the engine
// try every split point between them before failing, taking roughly
// quadratic time (CodeQL js/polynomial-redos; an 80 KB value measured
// around 2s with no cap). Capping the length first bounds that regardless
// of the pattern; the checks below also avoid the vulnerable shape
// entirely, using single-quantifier patterns and string splitting rather
// than one pattern with adjacent unbounded groups.
const MAX_EMAIL_LENGTH = 254;
const NO_WHITESPACE_OR_AT = /^[^\s@]+$/;

export function validateEmailAddress(value: string, field = 'ownerEmail'): EmailAddress {
  assertString(value, field);
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) {
    throw new FieldValidationError(
      field,
      `${field} must be 1-${MAX_EMAIL_LENGTH} characters, got ${value.length}.`
    );
  }
  const atIndex = value.indexOf('@');
  if (atIndex === -1 || atIndex !== value.lastIndexOf('@')) {
    throw new FieldValidationError(field, `${field} "${value}" must contain exactly one "@".`);
  }
  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  if (!NO_WHITESPACE_OR_AT.test(local) || !NO_WHITESPACE_OR_AT.test(domain)) {
    throw new FieldValidationError(field, `${field} "${value}" must not contain whitespace.`);
  }
  const dotIndex = domain.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === domain.length - 1) {
    throw new FieldValidationError(
      field,
      `${field} "${value}"'s domain must contain a "." with a label on each side.`
    );
  }
  return value as EmailAddress;
}
