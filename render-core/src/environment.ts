/**
 * The environment one tenant's Ghost container receives, split by where each
 * value is allowed to live — ported and extended from
 * `infra/tenant/environment.ts`: database and media become unions, and every
 * storage feature (`images`, `media`, `files`) renders the scanning decorator
 * rather than infra/tenant's bare `storage__active` / `storage__S3Storage__*`
 * pair — see `mediaEnvironment` below. SQLite emits
 * `database__client=sqlite3` plus `__connection__filename` and drops host,
 * port, user, password and ssl; local media wraps `Local*Storage` instead of
 * `S3Storage` and drops both S3 secrets, per the descriptor's own safety
 * posture rather than leaving it unset.
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
  MailSpec,
  MediaSpec,
  SafetySpec,
  TenantDescriptor,
  TransportSpec,
} from './descriptor.js';
import { renderSendingAddress, sendingDomainOf } from './mail.js';
import { mediaBucketName, mediaPublicBaseUrl, validateMediaBucket } from './media.js';
import { databaseAndUserName, validateDatabaseIdentity } from './naming.js';
import type { UploadLimits } from './runtime.js';
import type { ZoneConfig } from './validate.js';

/** Names of the secrets a rendered `mysql`/`s3` Compose file expects in the
 * process environment, i.e. the keys of `/etc/branchleft/<slug>.env`. A
 * `sqlite`/`local` tenant (every demo) never references any of these. */
export const SECRET_ENV_KEYS = {
  databasePassword: 'GHOST_DB_PASSWORD',
  s3AccessKeyId: 'GHOST_S3_ACCESS_KEY_ID',
  s3SecretAccessKey: 'GHOST_S3_SECRET_ACCESS_KEY',
  mailPassword: 'GHOST_MAIL_PASSWORD',
  bulkEmailApiKey: 'GHOST_BULK_EMAIL_API_KEY',
} as const;

const MULTIPART_UPLOAD_THRESHOLD_BYTES = 10485760; // 10 MiB
const MULTIPART_CHUNK_SIZE_BYTES = 5242880; // S3Storage's own floor

/** Ghost's own three separate storage adapters — one each for images, media
 * and files, not a single shared one. The decorator is configured
 * identically, and independently, for each — see `mediaEnvironment` below. */
const STORAGE_FEATURES = ['images', 'media', 'files'] as const;
type StorageFeature = (typeof STORAGE_FEATURES)[number];

/** Ghost's own per-feature URL path segment for the adapter it wraps — see
 * `adapters/scanning-storage/README.md`'s config table. `S3Storage` does
 * not infer this from the feature it is constructed for, so a wrong or
 * missing value here would serve every feature's media under `content/images`
 * silently — this is the one wrapped-config key this module supplies from a
 * fixed table rather than from the descriptor. */
const STATIC_FILE_URL_PREFIX: Record<StorageFeature, string> = {
  images: 'content/images',
  media: 'content/media',
  files: 'content/files',
};

/**
 * The custom storage adapter LLD-7 makes the load-bearing byte choke point
 * for every upload, and LLD-1 §04 says local media "sets storage__active
 * to the adapter named by safety" — wired in below.
 * `adapters/scanning-storage/src/`, copied into the image by the root
 * `Dockerfile`, is what this name resolves to at boot.
 */
export const SCANNING_STORAGE_ADAPTER = 'ScanningStorageAdapter';

/** Ghost's own compiled-in local adapters, one per storage feature — what the
 * decorator's `wraps` names for a demo (local media). A paying tenant's
 * `wraps` is `S3Storage` for every feature instead — see `mediaEnvironment`. */
const LOCAL_WRAPPED_ADAPTER: Record<StorageFeature, string> = {
  images: 'LocalImagesStorage',
  media: 'LocalMediaStorage',
  files: 'LocalFilesStorage',
};

/** Where a refused upload's bytes land, keyed by digest — see
 * `adapters/scanning-storage/README.md`. Always local disk, even when the
 * wrapped adapter is `S3Storage`: quarantine is never the served location,
 * so it never needs a bucket. Shared across all three features; a digest
 * name cannot collide between them. */
const QUARANTINE_PATH = '/var/lib/ghost/content/quarantine';

/**
 * The image's own fail-closed boot guard (`docker-entrypoint.branchleft.sh`)
 * refuses `storage__images__adapter` unset, refuses any adapter that is not
 * the decorator outright, and checks the wrapped adapter's own required
 * fields through `storage__images__wraps` /
 * `storage__images__wrappedConfig__*` rather than trusting a bare adapter
 * name — both read as "silently non-durable, or silently unscanned, media"
 * on the guard's own Cloud Run-era assumption. A demo host's local disk is
 * not Cloud Run's ephemeral instance disk, so that assumption does not hold
 * for a demo, and this is the guard's own documented, deliberate escape
 * hatch: "local development / the SQLite smoke test only". A demo is
 * exactly that case.
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
 *
 * Every storage feature (`images`, `media`, `files`) is rendered
 * identically — the decorator wrapping the local adapter for a
 * demo, or `S3Storage` for a tenant — because a mechanism that scanned only
 * one feature, or only one kind, would leave the others silently
 * unprotected with every test for the one it did cover green. The three
 * features never diverge on which adapter
 * they wrap; only `STATIC_FILE_URL_PREFIX` differs between them, because
 * `S3Storage` does not infer its own URL segment from the feature it was
 * constructed for.
 */
function mediaEnvironment(
  slug: Slug,
  media: MediaSpec,
  safety: SafetySpec
): Record<string, string | number | boolean> {
  const scanningRequired = isScanningRequired(safety);
  const env: Record<string, string | number | boolean> = {};

  if (media.kind === 'local') {
    for (const feature of STORAGE_FEATURES) {
      if (scanningRequired) {
        // `storage__<feature>__adapter` is explicit, never omitted: the
        // image's boot guard refuses to start Ghost at all when the images
        // feature's is unset or is not the decorator.
        // `ALLOW_LOCAL_STORAGE_ENV_VAR` is required alongside it, or the
        // same guard refuses a decorator wrapping a `Local*Storage` value
        // too — see that constant's own comment.
        env[`storage__${feature}__adapter`] = SCANNING_STORAGE_ADAPTER;
        env[`storage__${feature}__wraps`] = LOCAL_WRAPPED_ADAPTER[feature];
        env[`storage__${feature}__quarantinePath`] = QUARANTINE_PATH;
      } else {
        // Never reached today — see this function's own doc comment — kept
        // so a future off-flag descriptor renders a real adapter rather
        // than a decorator with nothing to run.
        env[`storage__${feature}__adapter`] = LOCAL_WRAPPED_ADAPTER[feature];
      }
    }
    env[ALLOW_LOCAL_STORAGE_ENV_VAR] = true;
    // Nothing here names an env var for `resize` / `srcsets` — LLD-1 §03b's
    // `media` row and LLD-7 both place responsive-image generation behind
    // the storage adapter itself (`handleImageSizes` reads the original
    // through it), not behind a Ghost core env var, so wiring those two
    // flags belongs to whatever story builds or configures that adapter.
    return env;
  }

  validateMediaBucket(slug, media);
  const bucket = mediaBucketName(slug);
  for (const feature of STORAGE_FEATURES) {
    if (scanningRequired) {
      env[`storage__${feature}__adapter`] = SCANNING_STORAGE_ADAPTER;
      env[`storage__${feature}__wraps`] = 'S3Storage';
      env[`storage__${feature}__quarantinePath`] = QUARANTINE_PATH;
      env[`storage__${feature}__wrappedConfig__bucket`] = bucket;
      env[`storage__${feature}__wrappedConfig__region`] = media.region;
      env[`storage__${feature}__wrappedConfig__endpoint`] = media.endpoint;
      env[`storage__${feature}__wrappedConfig__forcePathStyle`] = true;
      // No `tenantPrefix`: Ghost stores keys unprefixed when it is absent,
      // which is what a bucket holding exactly one tenant's objects wants.
      env[`storage__${feature}__wrappedConfig__staticFileURLPrefix`] =
        STATIC_FILE_URL_PREFIX[feature];
      env[`storage__${feature}__wrappedConfig__cdnUrl`] = mediaPublicBaseUrl(media.endpoint, slug);
      env[`storage__${feature}__wrappedConfig__multipartUploadThresholdBytes`] =
        MULTIPART_UPLOAD_THRESHOLD_BYTES;
      env[`storage__${feature}__wrappedConfig__multipartChunkSizeBytes`] =
        MULTIPART_CHUNK_SIZE_BYTES;
    } else {
      // Never reached today — see this function's own doc comment.
      env[`storage__${feature}__adapter`] = 'S3Storage';
      env[`storage__${feature}__bucket`] = bucket;
      env[`storage__${feature}__region`] = media.region;
      env[`storage__${feature}__endpoint`] = media.endpoint;
      env[`storage__${feature}__forcePathStyle`] = true;
      env[`storage__${feature}__staticFileURLPrefix`] = STATIC_FILE_URL_PREFIX[feature];
      env[`storage__${feature}__cdnUrl`] = mediaPublicBaseUrl(media.endpoint, slug);
      env[`storage__${feature}__multipartUploadThresholdBytes`] = MULTIPART_UPLOAD_THRESHOLD_BYTES;
      env[`storage__${feature}__multipartChunkSizeBytes`] = MULTIPART_CHUNK_SIZE_BYTES;
    }
  }
  return env;
}

/**
 * `transport` env wiring stays deliberately narrow: `smtp` renders the
 * three non-secret fields a caller supplies for the transactional path;
 * `queue` (the platform's own local mail spool, addressed some other way)
 * renders no Ghost env var at all. Member mail is addressed through a
 * Ghost *setting* (`members_support_address`, `settings.ts`), not the
 * `mail__from` env var below — this function carries neither, on purpose.
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
 * The sending-identity keys `transport` cannot carry (closes the gap
 * `test/parity.test.ts` used to name): `mail__from` — the env var that
 * looks like the address Ghost sends member mail from and is not, kept
 * identical to `settings.ts`'s `members_support_address` by construction
 * (both come from `mail.ts#renderSendingAddress`, never computed twice —
 * see that module's own doc comment for the trap this closes) — and,
 * whenever mail is enabled, the three keys that point Ghost's hardcoded
 * Mailgun bulk provider at the host's own spool instead of Mailgun itself
 * (LLD-6 §03: "one mail spool per host, serving both SMTP and the
 * Mailgun-shaped API"). Rendered from `mail.enabled` and the sending
 * identity alone — never from `transport.kind` — so a demo (whose
 * transactional path may be `queue`, carrying no host at all) still gets
 * a bulk path pointed at the spool; the two paths share a spool, not a
 * `TransportSpec` variant.
 */
function bulkMailEnvironment(
  mail: MailSpec,
  zones: Pick<ZoneConfig, 'demoMailDomain' | 'mailSpoolBaseUrl'>
): Record<string, string | number | boolean> {
  const env: Record<string, string | number | boolean> = {
    mail__from: renderSendingAddress(mail.identity, zones),
  };
  if (mail.enabled) {
    env.bulkEmail__mailgun__baseUrl = zones.mailSpoolBaseUrl;
    env.bulkEmail__mailgun__domain = sendingDomainOf(mail.identity, zones);
  }
  return env;
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
    'slug' | 'siteUrl' | 'database' | 'media' | 'transport' | 'mail' | 'safety' | 'limits'
  >,
  limits: UploadLimits,
  secretsFilePath: string,
  zones: Pick<ZoneConfig, 'demoMailDomain' | 'mailSpoolBaseUrl'>
): Record<string, string | number | boolean> {
  const env: Record<string, string | number | boolean> = {
    url: descriptor.siteUrl,
    ...databaseEnvironment(descriptor.slug, descriptor.database),
    ...mediaEnvironment(descriptor.slug, descriptor.media, descriptor.safety),
    ...transportEnvironment(descriptor.transport),
    ...bulkMailEnvironment(descriptor.mail, zones),
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
    const scanningRequired = isScanningRequired(descriptor.safety);
    for (const feature of STORAGE_FEATURES) {
      const prefix = scanningRequired
        ? `storage__${feature}__wrappedConfig__`
        : `storage__${feature}__`; // never reached today — see mediaEnvironment's own doc comment
      escaped[`${prefix}accessKeyId`] = required('s3AccessKeyId', secretsFilePath);
      escaped[`${prefix}secretAccessKey`] = required('s3SecretAccessKey', secretsFilePath);
    }
  }
  if (descriptor.transport.kind === 'smtp') {
    escaped.mail__options__auth__pass = required('mailPassword', secretsFilePath);
  }
  if (descriptor.mail.enabled) {
    escaped.bulkEmail__mailgun__apiKey = required('bulkEmailApiKey', secretsFilePath);
  }

  return escaped;
}
