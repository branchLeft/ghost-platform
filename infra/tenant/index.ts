import * as pulumi from '@pulumi/pulumi';
import { renderComposeStack } from './compose';
import {
  SECRET_ENV_KEYS,
  tenantEnvironment,
  tenantSecretsEnvFile,
  type TenantBulkEmailConfig,
  type TenantMailConfig,
  type TenantMediaConfig,
} from './environment';
import {
  adaptersVolumeName,
  composeUnitName,
  contentVolumeName,
  databaseAndUserName,
  imageEnvPath,
  secretsEnvPath,
  stackDirectory,
  stackName,
  validateTenantSlug,
} from './naming';
import {
  DEFAULT_RESOURCE_CAPS,
  DEFAULT_RSS_BUDGET_MIB,
  DEFAULT_UPLOAD_CEILING_MIB,
  uploadLimits,
  validateTenantUid,
  type ResourceCaps,
} from './runtime';

export interface GhostTenantDatabaseArgs {
  /** `db1`'s private address, e.g. `10.20.1.20`. */
  host: string;
  /** Defaults to 3306. */
  port?: number;
  /** The password `db/provision/provision_tenant_db.py` printed when it
   * created this tenant's account. Never re-derived, never defaulted: that
   * script prints it once and prints nothing on a re-run. */
  password: pulumi.Input<string>;
  /** Applied by the provisioning script, recorded here so the tenant's
   * configured cap is visible in its own repo. Defaults to 10. */
  maxUserConnections?: number;
}

export interface GhostTenantMediaArgs extends TenantMediaConfig {
  accessKeyId: pulumi.Input<string>;
  secretAccessKey: pulumi.Input<string>;
}

export interface GhostTenantMailArgs extends TenantMailConfig {
  password: pulumi.Input<string>;
}

export interface GhostTenantBulkEmailArgs extends TenantBulkEmailConfig {
  apiKey: pulumi.Input<string>;
}

export interface GhostTenantArgs {
  /**
   * Short tenant identifier, e.g. `blog`. Plain `string`, not an Input: it is
   * the Compose project name, the systemd instance name, the directory under
   * `/opt/branchleft`, the stem of both files under `/etc/branchleft`, the
   * MySQL database and account name and both volume names, so it has to be
   * usable synchronously.
   */
  slug: string;

  /** Public site URL including protocol. Ghost refuses to boot without one. */
  siteUrl: string;

  /**
   * This tenant's reserved UID, distinct per tenant on the host and never
   * reused. Required rather than derived: it is host state, allocated by the
   * host-side provisioning step against what is already claimed on that host,
   * and a value this component computed from the slug would collide the first
   * time two hosts disagreed about who lives where.
   */
  uid: number;

  /** The app host's private address. Every published port binds this. */
  appHostPrivateIp: string;

  /** Host-side port for this tenant's Ghost. Distinct per tenant on a host;
   * the edge reaches this over the private network. */
  hostPort: number;

  database: GhostTenantDatabaseArgs;
  media: GhostTenantMediaArgs;
  mail?: GhostTenantMailArgs;
  bulkEmail?: GhostTenantBulkEmailArgs;

  /**
   * The single number every upload-related limit derives from, in MiB: the
   * `/tmp` tmpfs `size=`, the three `theme__uploadLimits__*` values, the
   * tenant's Caddy `request_body` limit at the edge, and the tmpfs half of
   * `mem_limit`. One input because three separately-configured limits that
   * must agree is exactly the kind of thing that drifts.
   */
  uploadCeilingMib?: number;

  /** Ghost's resident-set budget in MiB, before the tmpfs ceiling is added. */
  rssBudgetMib?: number;

  /** CPU, PID and descriptor caps. Defaults are sized for a `cx23`-class host. */
  resourceCaps?: Partial<ResourceCaps>;
}

/**
 * The fields whose change destroys or orphans live tenant data rather than
 * updating it — read by `scripts/assert-no-tenant-deletes.py` out of the
 * component's own preview state. Every one of them names something that
 * already holds data by the time a second apply happens: rename the content
 * volume and the tenant's themes, settings and generated assets are orphaned
 * on the host under the old name; change the UID and the tenant loses access
 * to its own `0700` volume; change the database name and Ghost boots against
 * an empty schema.
 */
export interface GhostTenantIdentity {
  slug: string;
  uid: number;
  stackName: string;
  contentVolume: string;
  adaptersVolume: string;
  databaseName: string;
  appHostPrivateIp: string;
  maxUserConnections: number;
}

const DEFAULT_DB_PORT = 3306;
const DEFAULT_MAX_USER_CONNECTIONS = 10;

/**
 * Everything one Ghost tenant needs on a shared Hetzner app host, rendered
 * rather than created.
 *
 * **This component declares no cloud resources, and that is the design.** Every
 * durable thing a tenant uses already exists and is shared: the app host and
 * the database host come from the estate's own stack, the tenant's database
 * and DB account are created on `db1` by `db/provision/provision_tenant_db.py`,
 * and object storage is an account-level service. What is genuinely per-tenant
 * is *configuration* — a Compose stack carrying a runtime-isolation posture, a
 * secrets file, a UID, two volumes and a set of Ghost environment variables —
 * and that is what this produces. The tenant's Pulumi stack is therefore the
 * versioned, reviewed, passphrase-wrapped record of that configuration, and
 * its checkpoint is what a delete guard has to protect.
 *
 * Three steps outside Pulumi have to have happened before the stack this
 * renders will start, and each fails loudly rather than silently if it has
 * not: the tenant's database and DB account on `db1`
 * (`provision_tenant_db.py`), the tenant's two named volumes on the app host
 * owned by `uid` at `0700` (`app/provision/provision_tenant_volume.py`), and
 * the secrets file at `/etc/branchleft/<slug>.env`.
 */
export class GhostTenant extends pulumi.ComponentResource {
  public readonly slug: string;
  public readonly uid: number;
  /** Compose project, systemd instance and `/opt/branchleft` directory name. */
  public readonly stackName: string;
  public readonly stackDirectory: string;
  public readonly composeUnit: string;
  public readonly secretsEnvPath: string;
  public readonly imageEnvPath: string;
  public readonly contentVolume: string;
  public readonly adaptersVolume: string;
  public readonly databaseName: string;
  public readonly databaseUser: string;
  /** The rendered `compose.yml` for `/opt/branchleft/<slug>/`. */
  public readonly composeFile: string;
  /** The tenant's Caddy `request_body max_size`, for the edge site registry.
   * Derived from the same input as the tmpfs ceiling so the two cannot
   * disagree. */
  public readonly edgeRequestBodyMaxSize: string;
  /** The exact root-run command that must create this tenant's volumes before
   * its unit is enabled. */
  public readonly hostProvisioningCommand: string;
  /** The exact content of `/etc/branchleft/<slug>.env`. A Pulumi secret: it
   * carries the tenant's database password and, where configured, its SMTP
   * and bulk-mail credentials. */
  public readonly secretsEnvFile: pulumi.Output<string>;
  /** See `GhostTenantIdentity`. Registered as one output so the tenant-stack
   * delete guard has a single place to compare old against new. */
  public readonly identity: pulumi.Output<GhostTenantIdentity>;

  constructor(name: string, args: GhostTenantArgs, opts?: pulumi.ComponentResourceOptions) {
    super('ghostPlatform:tenant:GhostTenant', name, {}, opts);

    validateTenantSlug(args.slug);
    validateTenantUid(args.uid);

    const limits = uploadLimits(
      args.uploadCeilingMib ?? DEFAULT_UPLOAD_CEILING_MIB,
      args.rssBudgetMib ?? DEFAULT_RSS_BUDGET_MIB
    );
    const caps = { ...DEFAULT_RESOURCE_CAPS, ...args.resourceCaps };

    this.slug = args.slug;
    this.uid = args.uid;
    this.stackName = stackName(args.slug);
    this.stackDirectory = stackDirectory(args.slug);
    this.composeUnit = composeUnitName(args.slug);
    this.secretsEnvPath = secretsEnvPath(args.slug);
    this.imageEnvPath = imageEnvPath(args.slug);
    this.contentVolume = contentVolumeName(args.slug);
    this.adaptersVolume = adaptersVolumeName(args.slug);
    this.databaseName = databaseAndUserName(args.slug);
    this.databaseUser = this.databaseName;
    this.edgeRequestBodyMaxSize = limits.edgeRequestBodyMaxSize;

    this.composeFile = renderComposeStack({
      slug: args.slug,
      uid: args.uid,
      appHostPrivateIp: args.appHostPrivateIp,
      hostPort: args.hostPort,
      limits,
      caps,
      environment: tenantEnvironment(
        {
          siteUrl: args.siteUrl,
          database: {
            host: args.database.host,
            port: args.database.port ?? DEFAULT_DB_PORT,
            name: this.databaseName,
            user: this.databaseUser,
          },
          media: {
            endpoint: args.media.endpoint,
            region: args.media.region,
            bucket: args.media.bucket,
            tenantPrefix: args.media.tenantPrefix,
            publicBaseUrl: args.media.publicBaseUrl,
          },
          limits,
          mail: args.mail,
          bulkEmail: args.bulkEmail,
        },
        this.secretsEnvPath
      ),
    });

    this.hostProvisioningCommand = `provision_tenant_volume.py --uid ${args.uid} ${args.slug}`;

    this.secretsEnvFile = pulumi.secret(
      pulumi
        .all([
          args.database.password,
          args.media.accessKeyId,
          args.media.secretAccessKey,
          args.mail?.password ?? pulumi.output(undefined),
          args.bulkEmail?.apiKey ?? pulumi.output(undefined),
        ])
        .apply(
          ([databasePassword, s3AccessKeyId, s3SecretAccessKey, mailPassword, bulkEmailApiKey]) =>
            tenantSecretsEnvFile(args.slug, {
              databasePassword,
              s3AccessKeyId,
              s3SecretAccessKey,
              mailPassword,
              bulkEmailApiKey,
            })
        )
    );

    this.identity = pulumi.output({
      slug: this.slug,
      uid: this.uid,
      stackName: this.stackName,
      contentVolume: this.contentVolume,
      adaptersVolume: this.adaptersVolume,
      databaseName: this.databaseName,
      appHostPrivateIp: args.appHostPrivateIp,
      maxUserConnections: args.database.maxUserConnections ?? DEFAULT_MAX_USER_CONNECTIONS,
    });

    this.registerOutputs({
      identity: this.identity,
      composeFile: this.composeFile,
      composeUnit: this.composeUnit,
      stackDirectory: this.stackDirectory,
      secretsEnvPath: this.secretsEnvPath,
      imageEnvPath: this.imageEnvPath,
      edgeRequestBodyMaxSize: this.edgeRequestBodyMaxSize,
      hostProvisioningCommand: this.hostProvisioningCommand,
      secretsEnvFile: this.secretsEnvFile,
    });
  }
}

export { SECRET_ENV_KEYS };
export { assertRuntimePosture, GHOST_CONTAINER_PORT, renderComposeStack } from './compose';
export { tenantEnvironment, tenantSecretsEnvFile } from './environment';
export {
  MAX_TENANT_SLUG_LENGTH,
  RESERVED_STACK_NAMES,
  adaptersVolumeName,
  composeUnitName,
  contentVolumeName,
  databaseAndUserName,
  imageEnvPath,
  secretsEnvPath,
  sqlIdentifier,
  stackDirectory,
  stackName,
  validateTenantSlug,
} from './naming';
export {
  DEFAULT_RESOURCE_CAPS,
  DEFAULT_RSS_BUDGET_MIB,
  DEFAULT_UPLOAD_CEILING_MIB,
  TENANT_UID_MAX,
  TENANT_UID_MIN,
  uploadLimits,
  validateTenantUid,
} from './runtime';
export type { ResourceCaps, UploadLimits } from './runtime';
export type {
  TenantBulkEmailConfig,
  TenantDatabaseConfig,
  TenantMailConfig,
  TenantMediaConfig,
} from './environment';
