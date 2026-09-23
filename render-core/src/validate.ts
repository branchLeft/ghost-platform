/**
 * The single entry point that enforces the descriptor's three cross-field
 * invariants, plus per-field well-formedness. Both reconcilers call this
 * before any side effect — see LLD-1 §05 — precisely so an invariant is
 * never checked (or skipped) independently in either caller.
 */

import {
  validateAbsoluteUrl,
  validateDigestPinnedRef,
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
 * The custom-domain precondition on a code-injection grant. Marked
 * load-bearing in the design, not one of the three numbered invariants —
 * kept as its own error type so a caller can tell the two classes apart.
 */
export class CodeInjectionPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeInjectionPreconditionError';
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

function validateTransport(transport: TenantDescriptor['transport']): void {
  if (transport.kind === 'smtp') {
    validatePort(transport.port, 'transport.port');
  }
}

function validateHostname(hostname: TenantDescriptor['hostname']): void {
  if (hostname.kind === 'theirs') {
    validateInstant(hostname.verifiedAt, 'hostname.verifiedAt');
  }
}

function validateCodeInjection(codeInjection: TenantDescriptor['codeInjection']): void {
  if (codeInjection.kind === 'granted' && codeInjection.until !== null) {
    validateInstant(codeInjection.until, 'codeInjection.until');
  }
}

/**
 * INV-1 — `codeInjection` is never `Open`, for any kind, with no exception.
 *
 * The type this package exports has no `Open` variant to construct, so this
 * exists to catch a descriptor assembled from untrusted data (parsed JSON,
 * a type assertion) rather than through this package's own constructors —
 * the one path a compile-time check cannot close.
 */
function checkInv1(descriptor: TenantDescriptor): void {
  const allowed = ['blocked', 'granted', 'managed'];
  if (!allowed.includes(descriptor.codeInjection.kind)) {
    throw new InvariantViolationError(
      'INV-1',
      `codeInjection.kind "${descriptor.codeInjection.kind}" is not one of ${allowed.join(', ')}. ` +
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
 * domain. Load-bearing in the design (not one of INV-1..3): injected script
 * on a hostname under the platform's own domain is script on the platform's
 * registrable domain, so the precondition keeps the blast radius on the
 * customer's own name.
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
 * Validates a complete descriptor: every field's own format, then the three
 * named invariants, then the code-injection hostname precondition. Returns
 * the same descriptor on success so a caller can chain it into `render()`;
 * throws on the first violation found rather than collecting every one,
 * because both callers reject before any side effect regardless of how many
 * things are wrong.
 */
export function validate(descriptor: TenantDescriptor): TenantDescriptor {
  validateSlug(descriptor.slug);
  validateAbsoluteUrl(descriptor.siteUrl);
  validateDigestPinnedRef(descriptor.image);
  validateTenantUid(descriptor.uid);
  validatePortTriple(descriptor.ports);
  validatePrivateIpV4(descriptor.appHostIp);
  validateDatabase(descriptor.database);
  validateTransport(descriptor.transport);
  validateHostname(descriptor.hostname);
  validateCodeInjection(descriptor.codeInjection);
  if (descriptor.expiresAt !== null) {
    validateInstant(descriptor.expiresAt, 'expiresAt');
  }

  checkInv1(descriptor);
  checkInv2(descriptor);
  checkInv3(descriptor);
  checkCodeInjectionHostnamePrecondition(descriptor);

  return descriptor;
}
