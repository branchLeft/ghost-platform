/**
 * The environment one tenant's Ghost container receives, split by where each
 * value is allowed to live — ported and extended from
 * `infra/tenant/environment.ts` (LLD-1 §04: "database and media become
 * unions. SQLite emits `database__client=sqlite3` plus
 * `__connection__filename` and drops host, port, user, password and ssl;
 * local media drops all ten `storage__S3Storage__*` keys and both S3
 * secrets").
 *
 * Every secret-shaped value below is a `${VAR:?…}` reference into
 * `/etc/branchleft/<slug>.env` (a paying tenant) or nothing at all (a demo,
 * whose `sqlite`/`local` variants need no credential) — never a literal
 * value. `render()` never receives a real secret to begin with, so this
 * module cannot leak one even if it tried; the reference form is kept
 * anyway so the rendered Compose file is honest about what it needs
 * supplied out of band.
 */

import type { Slug } from './brand.js';
import type { DatabaseSpec, MediaSpec, TenantDescriptor, TransportSpec } from './descriptor.js';
import { mediaBucketName, mediaPublicBaseUrl, validateMediaBucket } from './media.js';
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

function required(name: keyof typeof SECRET_ENV_KEYS, secretsFilePath: string): string {
  return `\${${SECRET_ENV_KEYS[name]}:?set ${SECRET_ENV_KEYS[name]} in ${secretsFilePath}}`;
}

function databaseEnvironment(database: DatabaseSpec): Record<string, string | number | boolean> {
  if (database.kind === 'sqlite') {
    return {
      database__client: 'sqlite3',
      database__connection__filename: database.path,
    };
  }
  return {
    database__client: 'mysql',
    database__connection__host: database.host,
    database__connection__port: database.port,
    database__connection__database: database.name,
    database__connection__user: database.user,
    // The password is never a parameter of this function — see the module
    // doc comment. `secretsFilePath` closes over it from the caller.
    database__connection__ssl__rejectUnauthorized: false,
  };
}

/**
 * `mediaBucketName`/`mediaPublicBaseUrl` re-derive the bucket and its public
 * URL from the slug rather than trusting `media.bucket` — the same
 * isolation control `media.ts` documents. `validateMediaBucket` throws
 * first if a descriptor's `bucket` disagrees, so this function never
 * silently substitutes one value for another.
 */
function mediaEnvironment(slug: Slug, media: MediaSpec): Record<string, string | number | boolean> {
  if (media.kind === 'local') {
    // No `storage__active`: Ghost's compiled default is its own local
    // filesystem adapter, so an absent key is the local adapter rather than
    // an unconfigured one. Nothing here names an env var for `resize` /
    // `srcsets` — LLD-1 §03b's `media` row and LLD-7 both place responsive
    // -image generation behind the storage adapter itself
    // (`handleImageSizes` reads the original through it), not behind a
    // Ghost core env var, so wiring those two flags belongs to whatever
    // story builds or configures that adapter, not to this one.
    return {};
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
 * of them — see `mail-programme-state` prior art: member mail is addressed
 * through a Ghost *setting* (`members_support_address`, rendered by
 * `settings.ts`), not the `mail__from` env var, so no such value belongs
 * here. `queue` (the platform's own local mail spool, consumed by the
 * mailgun-shim rather than by Ghost's own mail transport) renders no Ghost
 * env var at all: LLD-6 ("mail delivery") owns how a demo's outbound mail
 * reaches that spool, and fabricating a Ghost-side env mapping ahead of
 * that document would be a guess this module has no basis for.
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
 * The `environment:` block of the rendered Compose service, for every kind.
 * `secretsFilePath` only appears inside a `${…:?}` reference's own failure
 * message — see `naming.ts#secretsEnvPath` for the value a caller supplies.
 */
export function tenantEnvironment(
  descriptor: Pick<TenantDescriptor, 'slug' | 'siteUrl' | 'database' | 'media' | 'transport'>,
  limits: UploadLimits,
  secretsFilePath: string
): Record<string, string | number | boolean> {
  const env: Record<string, string | number | boolean> = {
    url: descriptor.siteUrl,
    ...databaseEnvironment(descriptor.database),
    ...mediaEnvironment(descriptor.slug, descriptor.media),
    ...transportEnvironment(descriptor.transport),

    security__allowWebhookInternalIPs: false,

    theme__uploadLimits__compressedBytes: limits.themeCompressedBytes,
    theme__uploadLimits__entryUncompressedBytes: limits.themeEntryUncompressedBytes,
    theme__uploadLimits__totalUncompressedBytes: limits.themeTotalUncompressedBytes,

    privacy__useUpdateCheck: false,
    logging__transports: '["stdout"]',
  };

  if (descriptor.database.kind === 'mysql') {
    env.database__connection__password = required('databasePassword', secretsFilePath);
  }
  if (descriptor.media.kind === 's3') {
    env.storage__S3Storage__accessKeyId = required('s3AccessKeyId', secretsFilePath);
    env.storage__S3Storage__secretAccessKey = required('s3SecretAccessKey', secretsFilePath);
  }
  if (descriptor.transport.kind === 'smtp') {
    env.mail__options__auth__pass = required('mailPassword', secretsFilePath);
  }

  return env;
}
