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
  if (typeof value !== 'object' || value === null) {
    throw new FieldValidationError(
      field,
      `${field} must be an object, got ${value === null ? 'null' : typeof value}.`
    );
  }
}

function assertNullableNumber(value: unknown, field: string): void {
  if (value !== null && (typeof value !== 'number' || Number.isNaN(value))) {
    throw new FieldValidationError(
      field,
      `${field} must be a number or null, got ${typeof value}.`
    );
  }
}

/**
 * Checks that every field `validate()` or a renderer reads exists and has
 * the right JS type, for the whole descriptor at once, before any format or
 * cross-field rule below assumes it. Every one of these was previously a
 * silent pass-through (a missing `limits`/`caps`/`safety`) or a raw
 * `TypeError` (a `.trim()` or `.kind` read off an absent nested field) —
 * this is the one place that turns both into the same named error. Each
 * union's own `kind` is not re-checked here: `assertDiscriminant` above (and
 * `checkInv1`, for `codeInjection`) already guarantee it is one of the
 * variant's declared literals, so the branches below only need to check the
 * fields *that variant* carries.
 */
function assertShape(descriptor: TenantDescriptor): void {
  assertNumber(descriptor.version, 'version');
  assertString(descriptor.slug, 'slug');
  assertString(descriptor.siteUrl, 'siteUrl');
  assertString(descriptor.image, 'image');
  assertString(descriptor.ownerEmail, 'ownerEmail');
  assertNumber(descriptor.uid, 'uid');
  assertString(descriptor.appHostIp, 'appHostIp');

  assertObject(descriptor.ports, 'ports');
  assertNumber(descriptor.ports.a, 'ports.a');
  assertNumber(descriptor.ports.b, 'ports.b');
  assertNumber(descriptor.ports.health, 'ports.health');

  if (descriptor.database.kind === 'sqlite') {
    assertString(descriptor.database.path, 'database.path');
  } else {
    assertString(descriptor.database.host, 'database.host');
    assertNumber(descriptor.database.port, 'database.port');
    assertString(descriptor.database.name, 'database.name');
    assertString(descriptor.database.user, 'database.user');
  }

  assertBoolean(descriptor.media.resize, 'media.resize');
  assertBoolean(descriptor.media.srcsets, 'media.srcsets');
  if (descriptor.media.kind === 'local') {
    assertString(descriptor.media.path, 'media.path');
  } else {
    assertString(descriptor.media.endpoint, 'media.endpoint');
    assertString(descriptor.media.region, 'media.region');
    assertString(descriptor.media.bucket, 'media.bucket');
  }

  if (descriptor.transport.kind === 'queue') {
    assertString(descriptor.transport.path, 'transport.path');
  } else {
    assertString(descriptor.transport.host, 'transport.host');
    assertNumber(descriptor.transport.port, 'transport.port');
    assertString(descriptor.transport.user, 'transport.user');
  }

  if (descriptor.hostname.kind === 'ours') {
    assertString(descriptor.hostname.sub, 'hostname.sub');
    assertBoolean(descriptor.hostname.gated, 'hostname.gated');
  } else {
    assertString(descriptor.hostname.fqdn, 'hostname.fqdn');
    assertString(descriptor.hostname.verifiedAt, 'hostname.verifiedAt');
  }

  if (descriptor.gate.kind === 'passphrase') {
    assertString(descriptor.gate.argon2idHash, 'gate.argon2idHash');
  }

  if (descriptor.backup.kind === 'bucket-native') {
    assertString(descriptor.backup.encryptionRecipient, 'backup.encryptionRecipient');
  }

  if (descriptor.codeInjection.kind === 'granted') {
    assertString(descriptor.codeInjection.by, 'codeInjection.by');
    assertString(descriptor.codeInjection.reason, 'codeInjection.reason');
    if (descriptor.codeInjection.until !== null) {
      assertString(descriptor.codeInjection.until, 'codeInjection.until');
    }
  } else if (descriptor.codeInjection.kind === 'managed') {
    assertString(descriptor.codeInjection.head, 'codeInjection.head');
    assertString(descriptor.codeInjection.foot, 'codeInjection.foot');
  }

  assertObject(descriptor.limits, 'limits');
  assertNullableNumber(descriptor.limits.membersCap, 'limits.membersCap');
  assertNullableNumber(descriptor.limits.staffCap, 'limits.staffCap');

  assertObject(descriptor.caps, 'caps');
  assertString(descriptor.caps.cpus, 'caps.cpus');
  assertNumber(descriptor.caps.cpuShares, 'caps.cpuShares');
  assertNumber(descriptor.caps.pidsLimit, 'caps.pidsLimit');
  assertNumber(descriptor.caps.nofile, 'caps.nofile');

  assertObject(descriptor.safety, 'safety');
  assertBoolean(descriptor.safety.near, 'safety.near');
  assertBoolean(descriptor.safety.exact, 'safety.exact');

  if (descriptor.expiresAt !== null) {
    assertString(descriptor.expiresAt, 'expiresAt');
  }
}

function validatePortTriple(ports: TenantDescriptor['ports']): void {
  validatePort(ports.a, 'ports.a');
  validatePort(ports.b, 'ports.b');
  validatePort(ports.health, 'ports.health');
}

function validateDatabase(database: TenantDescriptor['database']): void {
  if (database.kind === 'mysql') {
    validatePort(database.port, 'database.port');
  }
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
  if (transport.kind === 'smtp') {
    validatePort(transport.port, 'transport.port');
  }
}

function validateGate(gate: TenantDescriptor['gate']): void {
  if (gate.kind === 'passphrase' && gate.argon2idHash.trim() === '') {
    throw new FieldValidationError(
      'gate.argon2idHash',
      'gate.argon2idHash must be non-empty for a passphrase gate.'
    );
  }
}

// The platform's own zone for a demo/entry hostname it mints itself
// ("ours"): `<sub>.sites.branchleft.co.uk`. A "theirs" fqdn under this same
// zone would mean the "custom domain" precondition on a code-injection
// grant is nominal — injected script would still land on the platform's own
// registrable domain, which is exactly what the precondition exists to
// prevent.
const PLATFORM_ZONE = 'sites.branchleft.co.uk';

function isOutsidePlatformZone(fqdn: string): boolean {
  return fqdn !== PLATFORM_ZONE && !fqdn.endsWith(`.${PLATFORM_ZONE}`);
}

// A bounded inner group ({0,61}) rather than an unbounded one: this label
// pattern cannot itself backtrack catastrophically, however long the
// checked string is — see brand.ts's validateEmailAddress for why that
// property matters enough to call out here too.
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const MAX_FQDN_LENGTH = 253;

function isWellFormedFqdn(fqdn: string): boolean {
  if (fqdn.length === 0 || fqdn.length > MAX_FQDN_LENGTH) {
    return false;
  }
  const labels = fqdn.split('.');
  return labels.length >= 2 && labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label));
}

function validateHostname(hostname: TenantDescriptor['hostname']): void {
  if (hostname.kind !== 'theirs') {
    return;
  }
  validateInstant(hostname.verifiedAt, 'hostname.verifiedAt');
  if (!isWellFormedFqdn(hostname.fqdn)) {
    throw new FieldValidationError(
      'hostname.fqdn',
      `hostname.fqdn "${hostname.fqdn}" must be a well-formed, non-empty domain name.`
    );
  }
  if (!isOutsidePlatformZone(hostname.fqdn)) {
    throw new FieldValidationError(
      'hostname.fqdn',
      `hostname.fqdn "${hostname.fqdn}" must be outside the platform's own zone ` +
        `(${PLATFORM_ZONE}) — a custom domain is the whole point of "theirs".`
    );
  }
}

/**
 * `siteUrl`'s host must be exactly the host the rest of the descriptor
 * declares — the subdomain a `ours` hostname renders to, or a `theirs`
 * fqdn verbatim — so a renderer reading either field gets the same
 * answer.
 */
function checkSiteUrlMatchesHostname(descriptor: TenantDescriptor): void {
  const expectedHost =
    descriptor.hostname.kind === 'ours'
      ? `${descriptor.hostname.sub}.${PLATFORM_ZONE}`
      : descriptor.hostname.fqdn;
  const actualHost = new URL(descriptor.siteUrl).hostname;
  if (actualHost !== expectedHost) {
    throw new FieldValidationError(
      'siteUrl',
      `siteUrl's host "${actualHost}" must match the host the descriptor's hostname field ` +
        `declares ("${expectedHost}").`
    );
  }
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
 * Validates a complete descriptor: closed-set discriminants first (so
 * nothing below reads a field a wrong `kind` would not have), then the
 * schema version, then every field's own format, then the three named
 * invariants, the code-injection hostname precondition, the per-tier
 * variant rules, and the hostname/gate consistency check. Returns the same
 * descriptor on success so a caller can chain it into `render()`; throws on
 * the first violation found rather than collecting every one, because both
 * callers reject before any side effect regardless of how many things are
 * wrong.
 */
export function validate(descriptor: TenantDescriptor): TenantDescriptor {
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

  // Presence and type of every remaining field, all at once, before any
  // format validator or cross-field rule below reads one — see assertShape's
  // own doc comment.
  assertShape(descriptor);

  checkVersion(descriptor);

  validateSlug(descriptor.slug);
  validateAbsoluteUrl(descriptor.siteUrl);
  validateDigestPinnedRef(descriptor.image);
  validateEmailAddress(descriptor.ownerEmail, 'ownerEmail');
  validateTenantUid(descriptor.uid);
  validatePortTriple(descriptor.ports);
  validatePrivateIpV4(descriptor.appHostIp);
  validateDatabase(descriptor.database);
  validateBackup(descriptor.backup);
  validateTransport(descriptor.transport);
  validateHostname(descriptor.hostname);
  validateGate(descriptor.gate);
  validateCodeInjection(descriptor.codeInjection);
  if (descriptor.expiresAt !== null) {
    validateInstant(descriptor.expiresAt, 'expiresAt');
  }
  checkSafety(descriptor);
  checkSiteUrlMatchesHostname(descriptor);

  checkInv2(descriptor);
  checkInv3(descriptor);
  checkCodeInjectionHostnamePrecondition(descriptor);
  checkTierVariants(descriptor);
  checkHostnameGateConsistency(descriptor);

  return descriptor;
}
