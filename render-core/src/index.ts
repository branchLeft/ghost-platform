/**
 * The render core's descriptor package: the schema every reconciler renders
 * from, and the one place its invariants are enforced. No rendering logic
 * lives here yet — that is `compose.ts`/`environment.ts`/`edge.ts`/
 * `settings.ts` and friends, which this package's dependency closure
 * deliberately does not include.
 */

export type {
  AbsoluteUrl,
  Brand,
  DigestPinnedRef,
  EmailAddress,
  Instant,
  Port,
  PrivateIpV4,
  Slug,
  TenantUid,
} from './brand.js';
export {
  FieldValidationError,
  validateAbsoluteUrl,
  validateDigestPinnedRef,
  validateEmailAddress,
  validateInstant,
  validatePort,
  validatePrivateIpV4,
  validateSlug,
  validateTenantUid,
  TENANT_UID_MAX,
  TENANT_UID_MIN,
} from './brand.js';

export type {
  BackupSpec,
  CodeInjectionSpec,
  DatabaseSpec,
  GateSpec,
  HostnameSpec,
  LimitsSpec,
  MediaSpec,
  PortTriple,
  ResourceCaps,
  SafetySpec,
  TenantDescriptor,
  TenantKind,
  TransportSpec,
} from './descriptor.js';

export type { InvariantId } from './validate.js';
export {
  CodeInjectionPreconditionError,
  CURRENT_SCHEMA_VERSION,
  InvariantViolationError,
  TierMismatchError,
  UnknownDiscriminantError,
  UnknownSchemaVersionError,
  validate,
} from './validate.js';
