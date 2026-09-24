/**
 * The render core's descriptor package: the schema every reconciler renders
 * from, its invariants, and — from workspace#1183 — `render()`, the pure
 * descriptor-to-seven-artefacts step LLD-2 §03 calls "render". Its
 * dependency closure still contains no Pulumi module and no Node built-in;
 * `test/dependency-closure.test.ts` enforces both.
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

export type { InvariantId, ZoneConfig } from './validate.js';
export {
  CodeInjectionPreconditionError,
  CURRENT_SCHEMA_VERSION,
  InvariantViolationError,
  servedHostnameOf,
  TierMismatchError,
  UnknownDiscriminantError,
  UnknownSchemaVersionError,
  validate,
} from './validate.js';

export type { HashId, LeaseId, SlotLeaseRecord, SlotName } from './lease.js';
export {
  hashIdOf,
  leaseRecordFileName,
  MAX_LEASE_RECORD_BYTES,
  parseSlotLeaseRecord,
  validateHashId,
  validateLeaseId,
  validateSlotName,
} from './lease.js';

export type { Artefact } from './render.js';
export {
  render,
  renderSecretsTemplate,
  imageEnvPath,
  renderEdgeSiteBlock,
  renderSettings,
  renderIdentity,
} from './render.js';
export type { EdgeGate, EdgeSiteBlock } from './edge.js';
export type { GhostSettings, CodeInjectionSettings, HostLimitsSettings } from './settings.js';
export type { TenantIdentity } from './identity.js';

export { SECRET_ENV_KEYS, tenantEnvironment } from './environment.js';
export { renderComposeStack, assertRuntimePosture, GHOST_CONTAINER_PORT } from './compose.js';
export type { ComposeStackArgs } from './compose.js';
export {
  TENANT_DB_PREFIX,
  adaptersVolumeName,
  composeUnitName,
  contentVolumeName,
  databaseAndUserName,
  secretsEnvPath,
  sqlIdentifier,
  stackDirectory,
  stackName,
} from './naming.js';
export { DEFAULT_RSS_BUDGET_MIB, DEFAULT_UPLOAD_CEILING_MIB, uploadLimits } from './runtime.js';
export type { UploadLimits } from './runtime.js';
export {
  MEDIA_BUCKET_PREFIX,
  mediaBucketName,
  mediaPublicBaseUrl,
  validateMediaBucket,
} from './media.js';
