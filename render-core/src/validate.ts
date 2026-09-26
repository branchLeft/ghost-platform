/**
 * The single entry point that enforces the descriptor's cross-field rules,
 * plus per-field well-formedness. Both reconcilers call this before any side
 * effect, precisely so a rule is never checked (or skipped) independently in
 * either caller.
 */

import {
  FieldValidationError,
  assertNumber,
  assertString,
  validateAbsoluteUrl,
  validateDigestPinnedRef,
  validateEmailAddress,
  validateInstant,
  validatePort,
  validatePrivateIpV4,
  validateSlug,
  validateTenantUid,
} from './brand.js';
import type { TenantDescriptor } from './descriptor.js';
import { validateDatabaseIdentity, validateSlugAvailability } from './naming.js';
import { mediaPublicBaseUrl, validateMediaBucket } from './media.js';

export type InvariantId = 'INV-1' | 'INV-2' | 'INV-3';

/**
 * Thrown by exactly one of the three named checks below. `invariant` and the
 * message both name which one, so a test can assert either.
 */
export class InvariantViolationError extends Error {
  constructor(
    public readonly invariant: InvariantId,
    message: string
  ) {
    super(`${invariant}: ${message}`);
    this.name = 'InvariantViolationError';
  }
}

/**
 * The custom-domain precondition on a code-injection grant. Not one of the
 * three numbered invariants — kept as its own error type so a caller can
 * tell the two classes apart.
 */
export class CodeInjectionPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeInjectionPreconditionError';
  }
}

/**
 * A union's `kind` (or the descriptor's own) is not one of its declared
 * literals — including the value being missing, `null`, or not an object at
 * all. Thrown before any code that assumes a specific variant's shape runs.
 */
export class UnknownDiscriminantError extends Error {
  constructor(
    public readonly field: string,
    value: unknown
  ) {
    super(`${field}.kind is not a declared discriminant: got ${describeKind(value)}.`);
    this.name = 'UnknownDiscriminantError';
  }
}

/** Each kind's shape disagrees with what the design fixes for its tier. */
export class TierMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TierMismatchError';
  }
}

function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return `a non-object (${typeof value})`;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' ? `"${kind}"` : `a non-string kind (${typeof kind})`;
}

/**
 * Checks that `container.kind` is one of `allowed`, without normalising
 * case and without assuming `container` is even an object — a descriptor
 * arriving as parsed JSON can hand this `null`, `undefined`, or a value
 * whose `kind` is the wrong type entirely.
 */
function assertDiscriminant(container: unknown, field: string, allowed: readonly string[]): void {
  if (typeof container !== 'object' || container === null) {
    throw new UnknownDiscriminantError(field, container);
  }
  const kind = (container as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !allowed.includes(kind)) {
    throw new UnknownDiscriminantError(field, container);
  }
}

const TENANT_KIND_VALUES = ['demo', 'tenant'] as const;
const DATABASE_KIND_VALUES = ['sqlite', 'mysql'] as const;
const MEDIA_KIND_VALUES = ['local', 's3'] as const;
const TRANSPORT_KIND_VALUES = ['queue', 'smtp'] as const;
const HOSTNAME_KIND_VALUES = ['ours', 'theirs'] as const;
const GATE_KIND_VALUES = ['none', 'passphrase'] as const;
const BACKUP_KIND_VALUES = ['none', 'bucket-native'] as const;

/**
 * The schema versions this build of the package knows how to render. A
 * reconciler pinned to an older version fails loudly here rather than
 * rendering a stack missing whatever a newer schema added.
 */
export const CURRENT_SCHEMA_VERSION = 1;
const KNOWN_SCHEMA_VERSIONS: readonly number[] = [1];

export class UnknownSchemaVersionError extends Error {
  constructor(version: unknown) {
    super(
      `descriptor version ${JSON.stringify(version)} is not one this package knows how to ` +
        `render. Known versions: ${KNOWN_SCHEMA_VERSIONS.join(', ')}.`
    );
    this.name = 'UnknownSchemaVersionError';
  }
}

function checkVersion(descriptor: TenantDescriptor): void {
  if (!KNOWN_SCHEMA_VERSIONS.includes(descriptor.version)) {
    throw new UnknownSchemaVersionError(descriptor.version);
  }
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new FieldValidationError(
      field,
      `${field} must be a boolean, got ${value === null ? 'null' : typeof value}.`
    );
  }
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FieldValidationError(
      field,
      `${field} must be an object, got ${describeType(value)}.`
    );
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Rejects any key `allowed` doesn't name — including `__proto__`, which
 * `JSON.parse` (unlike object-literal syntax) creates as an ordinary own
 * property. A descriptor is exactly its declared fields, never "the
 * declared fields, plus whatever else happened to be on the wire."
 */
function assertNoUnknownKeys(value: object, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new FieldValidationError(field, `${field} has unknown key(s): ${unknown.join(', ')}.`);
  }
}

const DESCRIPTOR_KEYS = [
  'version',
  'kind',
  'slug',
  'siteUrl',
  'image',
  'ownerEmail',
  'uid',
  'ports',
  'appHostIp',
  'database',
  'media',
  'transport',
  'hostname',
  'gate',
  'backup',
  'codeInjection',
  'limits',
  'caps',
  'safety',
  'expiresAt',
] as const;
const PORTS_KEYS = ['a', 'b', 'health'] as const;
const DATABASE_SQLITE_KEYS = ['kind', 'path'] as const;
const DATABASE_MYSQL_KEYS = ['kind', 'host', 'port', 'name', 'user'] as const;
const MEDIA_LOCAL_KEYS = ['kind', 'path', 'resize', 'srcsets'] as const;
const MEDIA_S3_KEYS = ['kind', 'endpoint', 'region', 'bucket', 'resize', 'srcsets'] as const;
const TRANSPORT_QUEUE_KEYS = ['kind', 'path'] as const;
const TRANSPORT_SMTP_KEYS = ['kind', 'host', 'port', 'user'] as const;
const HOSTNAME_OURS_KEYS = ['kind', 'sub', 'gated'] as const;
const HOSTNAME_THEIRS_KEYS = ['kind', 'fqdn', 'verifiedAt'] as const;
const GATE_NONE_KEYS = ['kind'] as const;
const GATE_PASSPHRASE_KEYS = ['kind', 'argon2idHash'] as const;
const BACKUP_NONE_KEYS = ['kind'] as const;
const BACKUP_BUCKET_NATIVE_KEYS = ['kind', 'encryptionRecipient'] as const;
const CODE_INJECTION_BLOCKED_KEYS = ['kind'] as const;
const CODE_INJECTION_GRANTED_KEYS = ['kind', 'by', 'reason', 'until'] as const;
const CODE_INJECTION_MANAGED_KEYS = ['kind', 'head', 'foot'] as const;
const LIMITS_KEYS = ['membersCap', 'staffCap'] as const;
const CAPS_KEYS = ['cpus', 'cpuShares', 'pidsLimit', 'nofile'] as const;
const SAFETY_KEYS = ['near', 'exact'] as const;

function assertNullableNumber(value: unknown, field: string): void {
  if (value !== null && (typeof value !== 'number' || Number.isNaN(value))) {
    throw new FieldValidationError(
      field,
      `${field} must be a number or null, got ${typeof value}.`
    );
  }
}

/**
 * Finite, positive, whole and no larger than `ceiling` — the container-runtime
 * numbers where 0 or a negative value carries a *different* meaning to a
 * validator that skips range-checking: Compose reads a `pids_limit` of 0 or
 * -1 as "unlimited", on a host shared with every other demo tenant.
 * `Number.isSafeInteger` alone stops at ±2^53-1 — well above every ceiling
 * below, so a value like `1e300` or `2^53+2` needs the ceiling to be
 * rejected at all, not merely the safe-integer check.
 */
function assertFinitePositiveInteger(value: number, field: string, ceiling: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
    throw new FieldValidationError(
      field,
      `${field} must be a finite positive integer of at most ${ceiling}, got ${value}.`
    );
  }
}

/**
 * A cap of `null` means "no cap" — a negative or fractional one means
 * nothing at all, and anything past `ceiling` is not a real Ghost site's
 * membership or staff count, whatever `Number.isSafeInteger` lets through.
 */
function assertNonNegativeIntegerOrNull(
  value: number | null,
  field: string,
  ceiling: number
): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > ceiling)) {
    throw new FieldValidationError(
      field,
      `${field} must be a finite non-negative integer of at most ${ceiling}, or null, got ${value}.`
    );
  }
}

// A positive decimal, optionally fractional, with no leading zero unless the
// value is itself between 0 and 1 (`0.5`, never `0`, `00.5` or `1.`).
// Bounded by MAX_CPUS_LENGTH before matching — see validateEmailAddress in
// ./brand.ts for why a length cap always runs before a pattern does here.
const CPUS_PATTERN = /^(0\.\d*[1-9]\d*|[1-9]\d*(\.\d+)?)$/;
const MAX_CPUS_LENGTH = 32;

// No app host in this estate's fleet carries anywhere near this many cores;
// the ceiling exists to reject a value like a 32-digit string (which the
// length cap above alone does not: it is exactly at the character limit)
// while leaving every real allocation far under it.
const MAX_CPUS_VALUE = 128;

function validateCpus(value: string): void {
  if (value.length === 0 || value.length > MAX_CPUS_LENGTH) {
    throw new FieldValidationError(
      'caps.cpus',
      `caps.cpus must be 1-${MAX_CPUS_LENGTH} characters, got ${value.length}.`
    );
  }
  if (!CPUS_PATTERN.test(value)) {
    throw new FieldValidationError(
      'caps.cpus',
      `caps.cpus "${value}" must be a positive decimal, e.g. "1.0" or "0.5".`
    );
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric > MAX_CPUS_VALUE) {
    throw new FieldValidationError(
      'caps.cpus',
      `caps.cpus "${value}" must be at most ${MAX_CPUS_VALUE}.`
    );
  }
}

/**
 * Checks that every field `validate()` or a renderer reads exists, has the
 * right JS type, and — for the container-runtime numbers — the right range,
 * for the whole descriptor at once, before any format or cross-field rule
 * below assumes it. Also rejects a key nothing declared, at every object
 * level, so a descriptor is exactly its schema and nothing riding along
 * with it. Each union's own `kind` is not re-checked here:
 * `assertDiscriminant` above (and `checkInv1`, for `codeInjection`) already
 * guarantee it is one of the variant's declared literals, so the branches
 * below only need to check the fields *that variant* carries.
 */
function assertShape(descriptor: TenantDescriptor): void {
  assertNoUnknownKeys(descriptor, DESCRIPTOR_KEYS, 'descriptor');

  assertNumber(descriptor.version, 'version');
  assertString(descriptor.slug, 'slug');
  assertString(descriptor.siteUrl, 'siteUrl');
  assertString(descriptor.image, 'image');
  assertString(descriptor.ownerEmail, 'ownerEmail');
  assertNumber(descriptor.uid, 'uid');
  assertString(descriptor.appHostIp, 'appHostIp');

  assertObject(descriptor.ports, 'ports');
  assertNoUnknownKeys(descriptor.ports, PORTS_KEYS, 'ports');
  assertNumber(descriptor.ports.a, 'ports.a');
  assertNumber(descriptor.ports.b, 'ports.b');
  assertNumber(descriptor.ports.health, 'ports.health');

  if (descriptor.database.kind === 'sqlite') {
    assertNoUnknownKeys(descriptor.database, DATABASE_SQLITE_KEYS, 'database');
    assertString(descriptor.database.path, 'database.path');
  } else {
    assertNoUnknownKeys(descriptor.database, DATABASE_MYSQL_KEYS, 'database');
    assertString(descriptor.database.host, 'database.host');
    assertNumber(descriptor.database.port, 'database.port');
    assertString(descriptor.database.name, 'database.name');
    assertString(descriptor.database.user, 'database.user');
  }

  if (descriptor.media.kind === 'local') {
    assertNoUnknownKeys(descriptor.media, MEDIA_LOCAL_KEYS, 'media');
    assertString(descriptor.media.path, 'media.path');
  } else {
    assertNoUnknownKeys(descriptor.media, MEDIA_S3_KEYS, 'media');
    assertString(descriptor.media.endpoint, 'media.endpoint');
    assertString(descriptor.media.region, 'media.region');
    assertString(descriptor.media.bucket, 'media.bucket');
  }
  assertBoolean(descriptor.media.resize, 'media.resize');
  assertBoolean(descriptor.media.srcsets, 'media.srcsets');

  if (descriptor.transport.kind === 'queue') {
    assertNoUnknownKeys(descriptor.transport, TRANSPORT_QUEUE_KEYS, 'transport');
    assertString(descriptor.transport.path, 'transport.path');
  } else {
    assertNoUnknownKeys(descriptor.transport, TRANSPORT_SMTP_KEYS, 'transport');
    assertString(descriptor.transport.host, 'transport.host');
    assertNumber(descriptor.transport.port, 'transport.port');
    assertString(descriptor.transport.user, 'transport.user');
  }

  if (descriptor.hostname.kind === 'ours') {
    assertNoUnknownKeys(descriptor.hostname, HOSTNAME_OURS_KEYS, 'hostname');
    assertString(descriptor.hostname.sub, 'hostname.sub');
    assertBoolean(descriptor.hostname.gated, 'hostname.gated');
  } else {
    assertNoUnknownKeys(descriptor.hostname, HOSTNAME_THEIRS_KEYS, 'hostname');
    assertString(descriptor.hostname.fqdn, 'hostname.fqdn');
    assertString(descriptor.hostname.verifiedAt, 'hostname.verifiedAt');
  }

  if (descriptor.gate.kind === 'passphrase') {
    assertNoUnknownKeys(descriptor.gate, GATE_PASSPHRASE_KEYS, 'gate');
    assertString(descriptor.gate.argon2idHash, 'gate.argon2idHash');
  } else {
    assertNoUnknownKeys(descriptor.gate, GATE_NONE_KEYS, 'gate');
  }

  if (descriptor.backup.kind === 'bucket-native') {
    assertNoUnknownKeys(descriptor.backup, BACKUP_BUCKET_NATIVE_KEYS, 'backup');
    assertString(descriptor.backup.encryptionRecipient, 'backup.encryptionRecipient');
  } else {
    assertNoUnknownKeys(descriptor.backup, BACKUP_NONE_KEYS, 'backup');
  }

  if (descriptor.codeInjection.kind === 'granted') {
    assertNoUnknownKeys(descriptor.codeInjection, CODE_INJECTION_GRANTED_KEYS, 'codeInjection');
    assertString(descriptor.codeInjection.by, 'codeInjection.by');
    assertString(descriptor.codeInjection.reason, 'codeInjection.reason');
    if (descriptor.codeInjection.until !== null) {
      assertString(descriptor.codeInjection.until, 'codeInjection.until');
    }
  } else if (descriptor.codeInjection.kind === 'managed') {
    assertNoUnknownKeys(descriptor.codeInjection, CODE_INJECTION_MANAGED_KEYS, 'codeInjection');
    assertString(descriptor.codeInjection.head, 'codeInjection.head');
    assertString(descriptor.codeInjection.foot, 'codeInjection.foot');
  } else {
    assertNoUnknownKeys(descriptor.codeInjection, CODE_INJECTION_BLOCKED_KEYS, 'codeInjection');
  }

  assertObject(descriptor.limits, 'limits');
  assertNoUnknownKeys(descriptor.limits, LIMITS_KEYS, 'limits');
  assertNullableNumber(descriptor.limits.membersCap, 'limits.membersCap');
  assertNullableNumber(descriptor.limits.staffCap, 'limits.staffCap');

  assertObject(descriptor.caps, 'caps');
  assertNoUnknownKeys(descriptor.caps, CAPS_KEYS, 'caps');
  assertString(descriptor.caps.cpus, 'caps.cpus');
  assertNumber(descriptor.caps.cpuShares, 'caps.cpuShares');
  assertNumber(descriptor.caps.pidsLimit, 'caps.pidsLimit');
  assertNumber(descriptor.caps.nofile, 'caps.nofile');

  assertObject(descriptor.safety, 'safety');
  assertNoUnknownKeys(descriptor.safety, SAFETY_KEYS, 'safety');
  assertBoolean(descriptor.safety.near, 'safety.near');
  assertBoolean(descriptor.safety.exact, 'safety.exact');

  if (descriptor.expiresAt !== null) {
    assertString(descriptor.expiresAt, 'expiresAt');
  }
}

// cgroup v1's own kernel-enforced ceiling for `cpu.shares` — Docker's
// `--cpu-shares` cannot exceed it either.
const MAX_CPU_SHARES = 262144;
// Generous headroom over any real tenant's process count, well under a
// value that could exhaust the host's own pid space.
const MAX_PIDS_LIMIT = 100000;
// Linux's own default `fs.nr_open` ceiling — the kernel refuses a higher
// open-file limit without a sysctl change, so nothing rendered here could
// ever be honoured past it anyway.
const MAX_NOFILE = 1048576;
// Sane ceilings for a single Ghost site's membership and staff counts —
// comfortably above any tenant this platform has ever hosted, and nowhere
// near `Number.MAX_SAFE_INTEGER`.
const MAX_MEMBERS_CAP = 10_000_000;
const MAX_STAFF_CAP = 10_000;

/**
 * The range half of `assertShape`'s type checks: presence and JS type are
 * checked there; numeric bounds — including the safe-integer-ness and the
 * upper ceilings below — are checked here.
 */
function checkRanges(descriptor: TenantDescriptor): void {
  assertNonNegativeIntegerOrNull(
    descriptor.limits.membersCap,
    'limits.membersCap',
    MAX_MEMBERS_CAP
  );
  assertNonNegativeIntegerOrNull(descriptor.limits.staffCap, 'limits.staffCap', MAX_STAFF_CAP);
  validateCpus(descriptor.caps.cpus);
  assertFinitePositiveInteger(descriptor.caps.cpuShares, 'caps.cpuShares', MAX_CPU_SHARES);
  assertFinitePositiveInteger(descriptor.caps.pidsLimit, 'caps.pidsLimit', MAX_PIDS_LIMIT);
  assertFinitePositiveInteger(descriptor.caps.nofile, 'caps.nofile', MAX_NOFILE);
}

/** Below 1024, a rendered port would collide with a privileged service on a
 * host that already runs SSH — mirrors `infra/tenant/runtime.ts#validateHostPort`. */
const MIN_HOST_PORT = 1024;

function validatePortTriple(ports: TenantDescriptor['ports']): void {
  validatePort(ports.a, 'ports.a');
  validatePort(ports.b, 'ports.b');
  validatePort(ports.health, 'ports.health');
  for (const field of ['a', 'b', 'health'] as const) {
    if (ports[field] < MIN_HOST_PORT) {
      throw new FieldValidationError(
        `ports.${field}`,
        `ports.${field} ${ports[field]} must be at least ${MIN_HOST_PORT} — below it collides ` +
          `with a privileged service on a host that already runs SSH.`
      );
    }
  }
  // New with the blue/green ports.a/ports.b/ports.health triple (LLD-1
  // §03b): nothing about a single-port schema could conflate two roles,
  // but three same-typed numbers on one object can silently collide.
  if (ports.a === ports.b || ports.a === ports.health || ports.b === ports.health) {
    throw new FieldValidationError(
      'ports',
      `ports.a (${ports.a}), ports.b (${ports.b}) and ports.health (${ports.health}) must all ` +
        `differ — two roles bound to the same port is a silent collision, not a valid triple.`
    );
  }
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim() === '') {
    throw new FieldValidationError(field, `${field} must be non-empty.`);
  }
}

/**
 * A traversal segment reaches outside whatever directory the render core
 * placed the tenant in, and it must be absolute — every path this schema
 * carries names a fixed location under `/data`, `/var/spool` or similar, so
 * a relative one would resolve against whatever directory happened to be
 * the working one when a renderer's output ran, not a place this validator
 * ever inspected. A backslash is rejected outright rather than treated as a
 * separator: this schema's paths are Linux container paths, which never
 * need one, and allowing it would let a ".." segment hide from the
 * forward-slash split below (`"..\\x"` is a single segment to `split('/')`).
 */
function assertNonEmptyPath(value: string, field: string): void {
  assertNonEmptyString(value, field);
  if (value.includes('\\')) {
    throw new FieldValidationError(field, `${field} must not contain a backslash.`);
  }
  if (!value.startsWith('/')) {
    throw new FieldValidationError(field, `${field} must be an absolute path, got "${value}".`);
  }
  if (value.split('/').includes('..')) {
    throw new FieldValidationError(field, `${field} must not contain a ".." path segment.`);
  }
}

// A hostname or IPv4 literal's own character set — nothing a MySQL
// connection string or a shell reads specially. Rejecting anything outside
// it (a space, a ";") stops a value that merely fails to *name* a real host
// from being read as a second argument or command by whatever consumes it.
const HOST_CHAR_PATTERN = /^[A-Za-z0-9.-]+$/;

function assertValidHost(value: string, field: string): void {
  assertNonEmptyString(value, field);
  if (!HOST_CHAR_PATTERN.test(value)) {
    throw new FieldValidationError(
      field,
      `${field} "${value}" must contain only letters, digits, "." and "-".`
    );
  }
}

function validateDatabase(
  slug: TenantDescriptor['slug'],
  database: TenantDescriptor['database']
): void {
  if (database.kind === 'sqlite') {
    assertNonEmptyPath(database.path, 'database.path');
    return;
  }
  assertValidHost(database.host, 'database.host');
  validatePort(database.port, 'database.port');
  // A descriptor must never be able to name another tenant's database — the
  // same isolation control `validateMediaBucket` below applies to the
  // bucket.
  validateDatabaseIdentity(slug, database);
}

function validateMedia(slug: TenantDescriptor['slug'], media: TenantDescriptor['media']): void {
  if (media.kind === 'local') {
    assertNonEmptyPath(media.path, 'media.path');
    return;
  }
  assertNonEmptyString(media.region, 'media.region');
  // Throws for anything but a bare https host — see `mediaPublicBaseUrl`'s
  // own doc comment. Calling it here, at validate() time, is what stops
  // "javascript:alert(1)" (or an http endpoint, or one carrying a path)
  // from ever reaching a renderer inside an already-"valid" descriptor.
  mediaPublicBaseUrl(media.endpoint, slug);
  // A descriptor naming another tenant's bucket must not validate, not
  // merely be refused later by a caller that happens to re-check it.
  validateMediaBucket(slug, media);
}

// The comma/whitespace check is what "exactly one" means in practice: age
// (and every one-recipient-per-tenant scheme this could be swapped for)
// takes one recipient per `-r` flag or line, so either character is a sign
// this string actually holds more than one, silently encrypting a dump to
// more than the one tenant it belongs to.
const RECIPIENT_LIST_SEPARATOR = /[\s,]/;

function validateBackup(backup: TenantDescriptor['backup']): void {
  if (backup.kind !== 'bucket-native') {
    return;
  }
  if (backup.encryptionRecipient.trim() === '') {
    throw new FieldValidationError(
      'backup.encryptionRecipient',
      'backup.encryptionRecipient must be non-empty for bucket-native backup — exactly one ' +
        'recipient per tenant is what makes erasure a key destruction rather than a rewrite.'
    );
  }
  if (RECIPIENT_LIST_SEPARATOR.test(backup.encryptionRecipient)) {
    throw new FieldValidationError(
      'backup.encryptionRecipient',
      `backup.encryptionRecipient "${backup.encryptionRecipient}" must be exactly one recipient ` +
        `— no whitespace or commas, which would mean more than one.`
    );
  }
}

function validateTransport(transport: TenantDescriptor['transport']): void {
  if (transport.kind === 'queue') {
    assertNonEmptyPath(transport.path, 'transport.path');
    return;
  }
  assertNonEmptyString(transport.host, 'transport.host');
  validatePort(transport.port, 'transport.port');
}

function validateGate(gate: TenantDescriptor['gate']): void {
  if (gate.kind === 'passphrase' && gate.argon2idHash.trim() === '') {
    throw new FieldValidationError(
      'gate.argon2idHash',
      'gate.argon2idHash must be non-empty for a passphrase gate.'
    );
  }
}

/**
 * The zones `validate()` checks `ours`/`theirs` hostnames against. Deliberately
 * a parameter with no default: this package ships to a public repo, and the
 * platform's real domain names are not this document's to hard-code — a
 * caller (the Pulumi component, the broker) supplies its own.
 */
export interface ZoneConfig {
  /** The zone a demo's `ours` hostname renders under: `<sub>.<demoZone>`. */
  readonly demoZone: string;
  /** The zone a paying tenant's `ours` hostname renders under: `<sub>.<platformZone>`. */
  readonly platformZone: string;
  /**
   * Every registrable domain the estate owns. A `theirs` fqdn equal to, or a
   * subdomain of, any of these is rejected: the "custom domain" precondition
   * on a code-injection grant means genuinely outside the platform's own
   * name, not merely under a different-looking label of it.
   */
  readonly ownedDomains: readonly string[];
}

function normalizeDomain(value: string): string {
  const withoutTrailingDot = value.endsWith('.') ? value.slice(0, -1) : value;
  return withoutTrailingDot.toLowerCase();
}

function isEqualToOrSubdomainOf(fqdn: string, domain: string): boolean {
  const normalizedFqdn = normalizeDomain(fqdn);
  const normalizedDomain = normalizeDomain(domain);
  return normalizedFqdn === normalizedDomain || normalizedFqdn.endsWith(`.${normalizedDomain}`);
}

function isOutsideOwnedDomains(fqdn: string, ownedDomains: readonly string[]): boolean {
  return !ownedDomains.some((domain) => isEqualToOrSubdomainOf(fqdn, domain));
}

// A bounded inner group ({0,61}) rather than an unbounded one: this label
// pattern cannot itself backtrack catastrophically, however long the
// checked string is — see brand.ts's validateEmailAddress for why that
// property matters enough to call out here too. Lowercase only, matching
// this schema's slug: an uppercase label would otherwise let a descriptor
// whose `siteUrl` and `hostname` disagree only in case slip past the exact
// string match `checkSiteUrlMatchesHostname` relies on.
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_FQDN_LENGTH = 253;

// A last label that is all digits, or `0x` hex, is what `new URL(...).host`
// reads back as an IPv4 address in shorthand notation —
// `new URL('https://127.1').host` is `127.0.0.1`, and the same holds for
// `127.0.1`, `0x7f.1` and `0x7f.0.0.1`. Every label in a shorthand form is
// already digits (or hex) only, which is what lets this tell it apart from
// a DNS name without needing a separate IP-literal check: no real DNS TLD
// is, or could ever register as, purely numeric.
const NUMERIC_SHORTHAND_LAST_LABEL = /^(0x[0-9a-f]+|[0-9]+)$/i;

function isWellFormedFqdn(fqdn: string): boolean {
  if (fqdn.length === 0 || fqdn.length > MAX_FQDN_LENGTH) {
    return false;
  }
  const labels = fqdn.split('.');
  if (labels.length < 2 || !labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label))) {
    return false;
  }
  return !NUMERIC_SHORTHAND_LAST_LABEL.test(labels[labels.length - 1]);
}

/**
 * Every field of `zones` is caller-supplied, unbranded input — unlike the
 * descriptor, nothing upstream of `validate()` has ever checked it — so an
 * `ownedDomains` of `[]`, `[""]`, `[" x"]` or `[".x"]` must be refused here
 * rather than silently making every "theirs" fqdn look like it is outside
 * every owned domain (an empty or malformed entry can never match anything,
 * so `isOutsideOwnedDomains` would wrongly say "outside" for a domain that
 * is really inside), and `ownedDomains` arriving `undefined` (an unset env
 * var, split and never checked) must throw a named error rather than a raw
 * `TypeError` from `.some`. `demoZone`/`platformZone` are checked the same
 * way: each must be well-formed *and* equal to, or a subdomain of, an owned
 * domain — otherwise an empty `demoZone` renders every demo's `siteUrl` as
 * `https://<sub>.`, which is exactly as ill-formed as the fqdn checks below
 * exist to reject. Well-formedness is checked against each value
 * *normalised* (trailing dot trimmed, lowercased), matching how
 * `isEqualToOrSubdomainOf` already compares them below — a zone config is
 * caller-authored, not attacker-supplied, and case or a trailing dot is not
 * itself a defect the way it is in a "theirs" fqdn (see `validateHostname`'s
 * own comment on why *that* string is held to an exact-case standard).
 */
function validateZoneConfig(zones: ZoneConfig): void {
  if (typeof zones !== 'object' || zones === null) {
    throw new FieldValidationError('zones', `zones must be an object, got ${describeType(zones)}.`);
  }
  if (!Array.isArray(zones.ownedDomains) || zones.ownedDomains.length === 0) {
    throw new FieldValidationError(
      'zones.ownedDomains',
      `zones.ownedDomains must be a non-empty array of domain names, got ` +
        `${describeType(zones.ownedDomains)}.`
    );
  }
  zones.ownedDomains.forEach((domain, index) => {
    if (typeof domain !== 'string' || !isWellFormedFqdn(normalizeDomain(domain))) {
      throw new FieldValidationError(
        'zones.ownedDomains',
        `zones.ownedDomains[${index}] ${JSON.stringify(domain)} must be a well-formed domain name.`
      );
    }
  });
  for (const field of ['demoZone', 'platformZone'] as const) {
    const value = zones[field];
    if (typeof value !== 'string' || !isWellFormedFqdn(normalizeDomain(value))) {
      throw new FieldValidationError(
        `zones.${field}`,
        `zones.${field} ${JSON.stringify(value)} must be a well-formed domain name.`
      );
    }
    if (isOutsideOwnedDomains(value, zones.ownedDomains)) {
      throw new FieldValidationError(
        `zones.${field}`,
        `zones.${field} "${value}" must be equal to, or a subdomain of, one of zones.ownedDomains ` +
          `(${zones.ownedDomains.join(', ')}).`
      );
    }
  }
}

function validateHostname(hostname: TenantDescriptor['hostname'], zones: ZoneConfig): void {
  if (hostname.kind === 'ours') {
    if (!HOSTNAME_LABEL_PATTERN.test(hostname.sub)) {
      throw new FieldValidationError(
        'hostname.sub',
        `hostname.sub "${hostname.sub}" must be a valid DNS label.`
      );
    }
    return;
  }

  validateInstant(hostname.verifiedAt, 'hostname.verifiedAt');
  if (!isWellFormedFqdn(hostname.fqdn)) {
    throw new FieldValidationError(
      'hostname.fqdn',
      `hostname.fqdn "${hostname.fqdn}" must be a well-formed, non-empty domain name, and not an ` +
        `IP address literal or shorthand for one.`
    );
  }
  if (!isOutsideOwnedDomains(hostname.fqdn, zones.ownedDomains)) {
    throw new FieldValidationError(
      'hostname.fqdn',
      `hostname.fqdn "${hostname.fqdn}" must be outside every registrable domain the platform ` +
        `owns (${zones.ownedDomains.join(', ')}) — a custom domain is the whole point of "theirs".`
    );
  }
}

/**
 * `siteUrl` must be exactly `https://<expectedHost>`, or the same with one
 * trailing slash — the host a `ours` hostname renders to (which zone
 * depends on `kind`: a demo's `ours` renders under the demo zone, a paying
 * tenant's under the platform zone), or a `theirs` fqdn verbatim. An exact
 * string match, rather than parsing and checking each URL component,
 * because it is what rejects a port, a path, userinfo, a query, a
 * fragment or an uppercase host all at once, with no separate case to miss.
 */
function checkSiteUrlMatchesHostname(descriptor: TenantDescriptor, zones: ZoneConfig): void {
  const expectedHost =
    descriptor.hostname.kind === 'ours'
      ? `${descriptor.hostname.sub}.${descriptor.kind === 'demo' ? zones.demoZone : zones.platformZone}`
      : descriptor.hostname.fqdn;
  const expectedUrl = `https://${expectedHost}`;
  if (descriptor.siteUrl !== expectedUrl && descriptor.siteUrl !== `${expectedUrl}/`) {
    throw new FieldValidationError(
      'siteUrl',
      `siteUrl must be exactly "${expectedUrl}" or "${expectedUrl}/", got "${descriptor.siteUrl}".`
    );
  }
}

/**
 * The hostname a certificate-admission decision (Caddy's on-demand-TLS ask
 * endpoint) should admit for this descriptor, or `null` if this descriptor
 * must never reach that decision at all.
 *
 * A demo's `ours` hostname renders under the demo zone, but is never
 * admitted here: demo slots sit under a platform wildcard certificate, so
 * asking per-hostname for one would both waste an issuance and put a slot
 * name into a public, append-only CT log for good — which the never-reuse
 * rule for slot names cannot tolerate. `zones.demoZone` is therefore never
 * read by this function: the demo branch returns before anything would use
 * it. A `theirs` fqdn that is itself one of the platform's own owned
 * domains is refused for the same reason `validateHostname` refuses it as
 * a hostname at all — a "custom domain" is only a custom domain if it is
 * genuinely outside every domain the platform owns, not merely a
 * different-looking label of one.
 *
 * Deliberately narrower than `validate()`: a caller deciding whether to
 * admit a TLS handshake has no business validating, or having an opinion
 * on, every other field a descriptor carries.
 */
export function servedHostnameOf(
  descriptor: Pick<TenantDescriptor, 'kind' | 'hostname'>,
  zones: Pick<ZoneConfig, 'platformZone' | 'ownedDomains'>
): string | null {
  if (descriptor.hostname.kind === 'ours') {
    if (descriptor.kind === 'demo') {
      return null;
    }
    if (!HOSTNAME_LABEL_PATTERN.test(descriptor.hostname.sub)) {
      return null;
    }
    return normalizeDomain(`${descriptor.hostname.sub}.${zones.platformZone}`);
  }
  const fqdn = descriptor.hostname.fqdn;
  if (!isWellFormedFqdn(fqdn)) {
    return null;
  }
  if (!isOutsideOwnedDomains(fqdn, zones.ownedDomains)) {
    return null;
  }
  return normalizeDomain(fqdn);
}

/** Both flags are on for every tenant today — see SafetySpec's own doc comment. */
function checkSafety(descriptor: TenantDescriptor): void {
  if (!descriptor.safety.near || !descriptor.safety.exact) {
    throw new FieldValidationError(
      'safety',
      `safety.near and safety.exact must both be true, got near=${descriptor.safety.near} ` +
        `exact=${descriptor.safety.exact}.`
    );
  }
}

function validateCodeInjection(codeInjection: TenantDescriptor['codeInjection']): void {
  if (codeInjection.kind === 'granted') {
    if (codeInjection.by.trim() === '') {
      throw new FieldValidationError(
        'codeInjection.by',
        'codeInjection.by must be non-empty for a grant.'
      );
    }
    if (codeInjection.reason.trim() === '') {
      throw new FieldValidationError(
        'codeInjection.reason',
        'codeInjection.reason must be non-empty for a grant.'
      );
    }
    if (codeInjection.until !== null) {
      validateInstant(codeInjection.until, 'codeInjection.until');
    }
  }
}

/**
 * INV-1 — `codeInjection` is never `Open`, for any kind, with no exception.
 *
 * The type this package exports has no `Open` variant to construct, and
 * `blocked`/`granted`/`managed` is codeInjection's whole closed set, so this
 * check doubles as that field's own discriminant gate — including a
 * non-object `codeInjection` (`null`, `undefined`), which fails here with a
 * named error rather than a raw `TypeError` from reading `.kind` off it.
 */
function checkInv1(descriptor: TenantDescriptor): void {
  const allowed = ['blocked', 'granted', 'managed'];
  const raw = descriptor.codeInjection as unknown;
  const kind =
    typeof raw === 'object' && raw !== null ? (raw as { kind?: unknown }).kind : undefined;
  if (typeof kind !== 'string' || !allowed.includes(kind)) {
    throw new InvariantViolationError(
      'INV-1',
      `codeInjection must have a kind of ${allowed.join(', ')}; got ${describeKind(raw)}. ` +
        `codeInjection must never be open, for any kind and with no exception.`
    );
  }
}

/** INV-2 — `gate = "passphrase"` if and only if `kind = "demo"`. */
function checkInv2(descriptor: TenantDescriptor): void {
  const gated = descriptor.gate.kind === 'passphrase';
  const isDemo = descriptor.kind === 'demo';
  if (isDemo && !gated) {
    throw new InvariantViolationError(
      'INV-2',
      `kind "demo" requires gate.kind "passphrase", got "${descriptor.gate.kind}". An open demo ` +
        `is a configuration bug.`
    );
  }
  if (!isDemo && gated) {
    throw new InvariantViolationError(
      'INV-2',
      `kind "${descriptor.kind}" must not carry gate.kind "passphrase". A gated paying tenant is ` +
        `a configuration bug.`
    );
  }
}

/** INV-3 — `media.kind = "s3"` implies `backup.kind = "bucket-native"`. */
function checkInv3(descriptor: TenantDescriptor): void {
  if (descriptor.media.kind === 's3' && descriptor.backup.kind !== 'bucket-native') {
    throw new InvariantViolationError(
      'INV-3',
      `media.kind "s3" requires backup.kind "bucket-native", got "${descriptor.backup.kind}". A ` +
        `tenant with its own bucket and platform backups is backed up twice, or not at all.`
    );
  }
}

/**
 * A code-injection grant or managed injection requires a verified custom
 * domain: injected script on a hostname under the platform's own domain is
 * script on the platform's own registrable domain, so this precondition
 * keeps the blast radius on the customer's own name.
 */
function checkCodeInjectionHostnamePrecondition(descriptor: TenantDescriptor): void {
  const needsCustomDomain =
    descriptor.codeInjection.kind === 'granted' || descriptor.codeInjection.kind === 'managed';
  if (needsCustomDomain && descriptor.hostname.kind !== 'theirs') {
    throw new CodeInjectionPreconditionError(
      `codeInjection.kind "${descriptor.codeInjection.kind}" requires hostname.kind "theirs", ` +
        `got "${descriptor.hostname.kind}". A custom domain is a precondition for a ` +
        `code-injection grant.`
    );
  }
}

/**
 * Each kind's shape is fixed, not merely typical: a paying tenant is MySQL,
 * object-storage media and bucket-native backup; a demo is SQLite, local
 * media, no backup, carries no code-injection grant or managed injection at
 * all — removed from a demo, not merely defaulted off — reaches the
 * platform under its own `ours` hostname, never a custom domain, and always
 * carries an expiry: a demo that never expires is a paying tenant's
 * capacity a demo is silently holding.
 */
function checkTierVariants(descriptor: TenantDescriptor): void {
  if (descriptor.kind === 'tenant') {
    if (descriptor.database.kind !== 'mysql') {
      throw new TierMismatchError(
        `kind "tenant" requires database.kind "mysql", got "${descriptor.database.kind}".`
      );
    }
    if (descriptor.media.kind !== 's3') {
      throw new TierMismatchError(
        `kind "tenant" requires media.kind "s3", got "${descriptor.media.kind}".`
      );
    }
    // No separate backup check here: this function already forces a
    // tenant's media to "s3", so INV-3 (media "s3" implies backup
    // "bucket-native", checked earlier in validate()) already rejects a
    // tenant with the wrong backup — a second check here could never fire.
    return;
  }

  if (descriptor.database.kind !== 'sqlite') {
    throw new TierMismatchError(
      `kind "demo" requires database.kind "sqlite", got "${descriptor.database.kind}".`
    );
  }
  if (descriptor.media.kind !== 'local') {
    throw new TierMismatchError(
      `kind "demo" requires media.kind "local", got "${descriptor.media.kind}".`
    );
  }
  if (descriptor.backup.kind !== 'none') {
    throw new TierMismatchError(
      `kind "demo" requires backup.kind "none", got "${descriptor.backup.kind}".`
    );
  }
  if (descriptor.codeInjection.kind !== 'blocked') {
    throw new TierMismatchError(
      `kind "demo" must carry no code-injection grant or managed injection; got ` +
        `codeInjection.kind "${descriptor.codeInjection.kind}".`
    );
  }
  if (descriptor.hostname.kind !== 'ours') {
    throw new TierMismatchError(
      `kind "demo" requires hostname.kind "ours", got "${descriptor.hostname.kind}". A demo ` +
        `never reaches the platform under a custom domain.`
    );
  }
  if (descriptor.expiresAt === null) {
    throw new TierMismatchError('kind "demo" requires a non-null expiresAt.');
  }
}

/**
 * `hostname.ours.gated` and `gate` describe the same fact twice — whether a
 * site sits behind the passphrase gate — so a descriptor that disagrees with
 * itself is rejected rather than left to whichever field a renderer happens
 * to read.
 */
function checkHostnameGateConsistency(descriptor: TenantDescriptor): void {
  if (descriptor.hostname.kind === 'ours') {
    const expectedGated = descriptor.gate.kind === 'passphrase';
    if (descriptor.hostname.gated !== expectedGated) {
      throw new FieldValidationError(
        'hostname.gated',
        `hostname.gated (${descriptor.hostname.gated}) must equal whether gate.kind is ` +
          `"passphrase" (${expectedGated}).`
      );
    }
  }
}

/**
 * Validates a complete descriptor against the caller's zone configuration:
 * the zone configuration itself first (it is exactly as unchecked as the
 * descriptor, and every hostname check below trusts it), then closed-set
 * discriminants and unknown-key checks (so nothing below reads a field a
 * wrong `kind` would not have, or trusts a key nothing declared), then the
 * schema version, then every field's own format and range, then the three
 * named invariants, the code-injection hostname precondition, the per-tier
 * variant rules, and the hostname/gate and siteUrl/hostname consistency
 * checks. Returns the same descriptor on success so a caller can chain it
 * into `render()`; throws on the first violation found rather than
 * collecting every one, because both callers reject before any side effect
 * regardless of how many things are wrong.
 */
export function validate(descriptor: TenantDescriptor, zones: ZoneConfig): TenantDescriptor {
  // The caller's own input, checked before anything below trusts it to mean
  // what its fields say — see validateZoneConfig's own doc comment.
  validateZoneConfig(zones);

  assertDiscriminant(descriptor, 'kind', TENANT_KIND_VALUES);
  assertDiscriminant(descriptor.database, 'database', DATABASE_KIND_VALUES);
  assertDiscriminant(descriptor.media, 'media', MEDIA_KIND_VALUES);
  assertDiscriminant(descriptor.transport, 'transport', TRANSPORT_KIND_VALUES);
  assertDiscriminant(descriptor.hostname, 'hostname', HOSTNAME_KIND_VALUES);
  assertDiscriminant(descriptor.gate, 'gate', GATE_KIND_VALUES);
  assertDiscriminant(descriptor.backup, 'backup', BACKUP_KIND_VALUES);
  // codeInjection's discriminant gate is checkInv1, called here rather than
  // with the other invariants below: every per-field validator after this
  // point assumes codeInjection is already a valid object with one of its
  // three kinds, and checkInv1 is what makes that assumption safe.
  checkInv1(descriptor);

  // Presence, type, range and unknown-key checks for every remaining field,
  // all at once, before any format validator or cross-field rule below
  // reads one — see assertShape's own doc comment.
  assertShape(descriptor);
  checkRanges(descriptor);

  checkVersion(descriptor);

  validateSlug(descriptor.slug);
  validateSlugAvailability(descriptor.slug);
  validateAbsoluteUrl(descriptor.siteUrl);
  validateDigestPinnedRef(descriptor.image);
  validateEmailAddress(descriptor.ownerEmail, 'ownerEmail');
  validateTenantUid(descriptor.uid);
  validatePortTriple(descriptor.ports);
  validatePrivateIpV4(descriptor.appHostIp);
  validateDatabase(descriptor.slug, descriptor.database);
  validateMedia(descriptor.slug, descriptor.media);
  validateBackup(descriptor.backup);
  validateTransport(descriptor.transport);
  validateHostname(descriptor.hostname, zones);
  validateGate(descriptor.gate);
  validateCodeInjection(descriptor.codeInjection);
  if (descriptor.expiresAt !== null) {
    validateInstant(descriptor.expiresAt, 'expiresAt');
  }
  checkSafety(descriptor);
  checkSiteUrlMatchesHostname(descriptor, zones);

  checkInv2(descriptor);
  checkInv3(descriptor);
  checkCodeInjectionHostnamePrecondition(descriptor);
  checkTierVariants(descriptor);
  checkHostnameGateConsistency(descriptor);

  return descriptor;
}
