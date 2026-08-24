/**
 * The environment one tenant's Ghost container receives, split by where each
 * value is allowed to live.
 *
 * Two destinations, and the split is a security boundary rather than a
 * convenience:
 *
 * - The **Compose file** is committed to the tenant's repo and rendered into
 *   `/opt/branchleft/<slug>/compose.yml`. Every non-secret value is inline
 *   there, so what a tenant is configured with is reviewable in a diff.
 * - **`/etc/branchleft/<slug>.env`** is root-owned `0600` on the app host,
 *   holds only secrets, and is written by an operator — never by an automated
 *   path. The Compose file references those values as `${VAR:?…}`, so a
 *   missing secret fails the stack's start rather than booting Ghost with an
 *   empty password.
 *
 * Values are read by Ghost through nconf's `__`-separated env mapping with
 * `parseValues: true` (`ghost/core/core/shared/config/loader.ts`), so
 * `'false'` arrives as a boolean and a numeric string as a number. That is
 * why the booleans and byte counts below are written as their literal JSON
 * forms rather than as strings Ghost would have to coerce.
 */

import type { UploadLimits } from './runtime';

/** Names of the secrets the rendered Compose file expects in the process
 * environment, i.e. the keys of `/etc/branchleft/<slug>.env`. */
export const SECRET_ENV_KEYS = {
  databasePassword: 'GHOST_DB_PASSWORD',
  s3AccessKeyId: 'GHOST_S3_ACCESS_KEY_ID',
  s3SecretAccessKey: 'GHOST_S3_SECRET_ACCESS_KEY',
  mailPassword: 'GHOST_MAIL_PASSWORD',
  bulkEmailApiKey: 'GHOST_BULK_EMAIL_API_KEY',
} as const;

/** Platform-wide, not per-tenant. */
const MULTIPART_UPLOAD_THRESHOLD_BYTES = 10485760; // 10 MiB
/** S3Storage enforces a 5 MiB floor itself. */
const MULTIPART_CHUNK_SIZE_BYTES = 5242880;
/** Key prefix under the bucket; per-tenant separation is `tenantPrefix`,
 * layered underneath this. */
const STATIC_FILE_URL_PREFIX = 'content/images';

export interface TenantDatabaseConfig {
  /** `db1`'s private address. Never a public one — the account's own host
   * part is scoped to the private subnet at the server. */
  host: string;
  port: number;
  /** Both the logical database and the dedicated user; they share a name. */
  name: string;
  user: string;
}

export interface TenantMediaConfig {
  /** e.g. `https://hel1.your-objectstorage.com`. */
  endpoint: string;
  /** Must name the bucket's own location; a mismatch is an opaque 403. */
  region: string;
  bucket: string;
  /** This tenant's key prefix, without a trailing slash — `S3Storage.buildKey`
   * inserts the separator itself, and a slash here writes every object under
   * `<tenant>//`. */
  tenantPrefix: string;
  /** Public base URL objects are served from. Explicit rather than derived:
   * whether a tenant's media sits in its own bucket or behind a prefix in a
   * shared one is an open platform decision, and the two produce different
   * public URLs. */
  publicBaseUrl: string;
}

export interface TenantMailConfig {
  host: string;
  port: number;
  user: string;
  from: string;
}

export interface TenantBulkEmailConfig {
  baseUrl: string;
  domain: string;
}

export interface TenantEnvironmentArgs {
  siteUrl: string;
  database: TenantDatabaseConfig;
  media: TenantMediaConfig;
  limits: UploadLimits;
  mail?: TenantMailConfig;
  bulkEmail?: TenantBulkEmailConfig;
}

function required(name: keyof typeof SECRET_ENV_KEYS, path: string): string {
  return `\${${SECRET_ENV_KEYS[name]}:?set ${SECRET_ENV_KEYS[name]} in ${path}}`;
}

/**
 * The `environment:` block of the rendered Compose service.
 *
 * `secretsFilePath` only appears inside the failure message of each `${…:?}`
 * reference, so an operator reading a failed `systemctl start` is told which
 * file to look in rather than which variable name to search for.
 */
export function tenantEnvironment(
  args: TenantEnvironmentArgs,
  secretsFilePath: string
): Record<string, string | number | boolean> {
  const env: Record<string, string | number | boolean> = {
    url: args.siteUrl,

    database__client: 'mysql',
    database__connection__host: args.database.host,
    database__connection__port: args.database.port,
    database__connection__database: args.database.name,
    database__connection__user: args.database.user,
    database__connection__password: required('databasePassword', secretsFilePath),
    // `require_secure_transport = ON` on db1, so an unencrypted connection is
    // refused outright. mysql2 only negotiates TLS when an `ssl` object is
    // present at all, which is what this key's existence supplies; the
    // certificate is the server's own self-signed pair, generated into the
    // data directory on first start, so there is no chain to verify against
    // and verification is off deliberately rather than by oversight. The
    // boundary that makes that acceptable is the network: the account exists
    // only for `10.20.1.%` and db1 has no public listener.
    database__connection__ssl__rejectUnauthorized: false,

    storage__active: 'S3Storage',
    storage__S3Storage__bucket: args.media.bucket,
    storage__S3Storage__region: args.media.region,
    storage__S3Storage__endpoint: args.media.endpoint,
    storage__S3Storage__forcePathStyle: true,
    storage__S3Storage__tenantPrefix: args.media.tenantPrefix,
    storage__S3Storage__staticFileURLPrefix: STATIC_FILE_URL_PREFIX,
    storage__S3Storage__cdnUrl: args.media.publicBaseUrl,
    storage__S3Storage__multipartUploadThresholdBytes: MULTIPART_UPLOAD_THRESHOLD_BYTES,
    storage__S3Storage__multipartChunkSizeBytes: MULTIPART_CHUNK_SIZE_BYTES,
    storage__S3Storage__accessKeyId: required('s3AccessKeyId', secretsFilePath),
    storage__S3Storage__secretAccessKey: required('s3SecretAccessKey', secretsFilePath),

    // Ghost's own compiled default is already `false`, and that default is
    // the only thing between a tenant's integrations UI and the estate's
    // private network — a tenant admin can point a webhook at a private
    // address without needing a container escape at all. Stated explicitly so
    // that a Ghost release changing the default shows up as a diff here
    // rather than as an open path nobody looked at.
    security__allowWebhookInternalIPs: false,

    // The only limits that bound theme *extraction*, because they are what
    // Ghost hands to `gscan.checkZip`. A proxy in front cannot see how far a
    // compressed archive expands, so the edge's own body limit does not
    // substitute for these.
    theme__uploadLimits__compressedBytes: args.limits.themeCompressedBytes,
    theme__uploadLimits__entryUncompressedBytes: args.limits.themeEntryUncompressedBytes,
    theme__uploadLimits__totalUncompressedBytes: args.limits.themeTotalUncompressedBytes,

    privacy__useUpdateCheck: false,
    logging__transports: '["stdout"]',
  };

  if (args.mail) {
    env.mail__transport = 'SMTP';
    env.mail__options__host = args.mail.host;
    env.mail__options__port = args.mail.port;
    env.mail__options__secure = false;
    env.mail__options__auth__user = args.mail.user;
    env.mail__options__auth__pass = required('mailPassword', secretsFilePath);
    env.mail__from = args.mail.from;
  }

  if (args.bulkEmail) {
    // All three or none: Ghost treats the mere presence of the
    // `bulkEmail.mailgun` object as "configured" and crashes with
    // `new URL(undefined)` on a partial set, so there is no code path here
    // that can emit one or two of them.
    env.bulkEmail__mailgun__baseUrl = args.bulkEmail.baseUrl;
    env.bulkEmail__mailgun__domain = args.bulkEmail.domain;
    env.bulkEmail__mailgun__apiKey = required('bulkEmailApiKey', secretsFilePath);
  }

  return env;
}

export interface TenantSecrets {
  databasePassword: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  mailPassword?: string;
  bulkEmailApiKey?: string;
}

/**
 * The exact content of `/etc/branchleft/<slug>.env`.
 *
 * Rendered rather than templated so the file cannot disagree with the
 * `${…:?}` references in the Compose file beside it — both come from
 * `SECRET_ENV_KEYS`. Values are emitted bare, without quoting: systemd's
 * `EnvironmentFile` treats a quoted value as quoted and would carry the
 * quotes into the variable, and every value here is machine-generated from a
 * character set that needs none.
 */
export function tenantSecretsEnvFile(slug: string, secrets: TenantSecrets): string {
  const lines: string[] = [
    `# Secrets for the ${slug} Ghost stack. Root-owned, mode 0600.`,
    '# Written by an operator; no automated path may rewrite this file.',
    `${SECRET_ENV_KEYS.databasePassword}=${secrets.databasePassword}`,
    `${SECRET_ENV_KEYS.s3AccessKeyId}=${secrets.s3AccessKeyId}`,
    `${SECRET_ENV_KEYS.s3SecretAccessKey}=${secrets.s3SecretAccessKey}`,
  ];
  if (secrets.mailPassword !== undefined) {
    lines.push(`${SECRET_ENV_KEYS.mailPassword}=${secrets.mailPassword}`);
  }
  if (secrets.bulkEmailApiKey !== undefined) {
    lines.push(`${SECRET_ENV_KEYS.bulkEmailApiKey}=${secrets.bulkEmailApiKey}`);
  }
  return `${lines.join('\n')}\n`;
}
