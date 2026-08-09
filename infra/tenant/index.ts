import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { validateTenantName, createServiceAccount } from './serviceAccount';
import { createTenantDatabase, DEFAULT_MAX_USER_CONNECTIONS } from './database';
import { createTenantStorage } from './storage';
import { createCloudRunService, createPublicInvokerBinding } from './cloudRunService';

/**
 * Everything this component needs from the platform stack, imported by
 * whoever instantiates `GhostTenant` (the private `ghost-platform-tenants`
 * repo's own Pulumi program, per `infra/README.md`) -- typically via a
 * `pulumi.StackReference` to the `platform` stack's outputs. This component
 * deliberately does not resolve a `StackReference` itself: that would tie a
 * reusable, public component to one specific stack name/org, and would make
 * this component unusable in a preview-only smoke test without a real
 * platform stack to reference. Passing the values through as plain
 * constructor args keeps the component portable and testable, while the
 * *type* of each field still ties it to the platform stack's real export
 * shape -- see `infra/platform/index.ts` for where a real caller gets
 * these.
 */
export interface GhostTenantPlatformArgs {
  /** `infra/platform/index.ts`'s `dbInstanceConnectionName` export. */
  dbInstanceConnectionName: pulumi.Input<string>;
  /** `infra/platform/index.ts`'s `tenantImageRepositoryDockerPath` export. */
  tenantImageRepositoryDockerPath: pulumi.Input<string>;
  /** `infra/platform/index.ts`'s `mediaBucketUrl` export. */
  mediaBucketUrl: pulumi.Input<string>;
}

export interface GhostTenantArgs {
  /**
   * Short tenant identifier, e.g. `blog`, `example-news`. Must start
   * with a lowercase letter and contain only lowercase letters, digits and
   * hyphens; validated against GCP service-account-ID length limits at
   * construction time (see `serviceAccount.ts`). Derives the service
   * account ID, the logical database/DB-user names (hyphens folded to
   * underscores for MySQL identifier safety), the GCS managed-folder
   * prefix, and the Cloud Run service name -- deliberately plain `string`,
   * not `pulumi.Input<string>`, since it has to be usable synchronously to
   * build every other resource's name.
   */
  tenantName: string;

  /** Public site URL including protocol, e.g. `https://news.example.org`
   * -- becomes the `url` env var. Ghost refuses to boot without a
   * protocol-qualified URL (README). */
  siteUrl: pulumi.Input<string>;

  /**
   * The tag or digest of the tenant container image to deploy -- e.g.
   * `sha256:...` or a version tag, once one exists. **Required, and
   * deliberately not defaulted or hardcoded**: no image has been pushed to
   * `tenantImageRepositoryDockerPath` yet (pushing one is a separate,
   * not-yet-started story), so this component has nothing sane to default
   * to. Combined with `platform.tenantImageRepositoryDockerPath` as
   * `{tenantImageRepositoryDockerPath}/ghost:{imageDigestOrTag}` -- `ghost`
   * is this component's own choice of image name within the shared
   * repository (every tenant runs the same image, per this repo's README,
   * so there is exactly one image name, not one per tenant).
   */
  imageDigestOrTag: pulumi.Input<string>;

  /** Platform stack outputs this tenant's resources are provisioned
   * against. See `GhostTenantPlatformArgs`. */
  platform: GhostTenantPlatformArgs;

  /** Defaults to `'europe-west1'`, matching `infra/platform/config.ts`'s
   * own default -- doc 02's UK/EU data residency requirement
   * (OPEN-QUESTIONS.md #13), inherited the same way the platform stack
   * inherits it rather than re-decided here. Plain `string`: needed
   * synchronously as a `gcp.cloudrunv2.Service.location` argument. */
  region?: string;

  /** Cloud Run autoscaling ceiling. Defaults to 3, matching
   * website/infra/cloudRun.ts's own ceiling -- a near-zero-traffic tenant
   * has no reason to differ from the marketing site's upper bound, only
   * its floor (this component always scales to zero; see
   * `cloudRunService.ts`). */
  maxInstanceCount?: number;

  /** MySQL `MAX_USER_CONNECTIONS` to apply to this tenant's DB user.
   * Defaults to `DEFAULT_MAX_USER_CONNECTIONS` (10) -- see `database.ts`
   * for the reasoning, and for why this component can produce the
   * statement to apply this but cannot execute it itself. */
  maxUserConnections?: number;
}

const DEFAULT_REGION = 'europe-west1';
const DEFAULT_MAX_INSTANCE_COUNT = 3;

/**
 * Everything one Ghost tenant needs on top of the shared platform stack:
 * a dedicated service account, a logical database + DB user on the shared
 * Cloud SQL instance, write-isolated storage on the shared media bucket,
 * and a scale-to-zero Cloud Run service wired to all of it. See the
 * per-concern files (`serviceAccount.ts`, `database.ts`, `storage.ts`,
 * `cloudRunService.ts`) for the reasoning behind each piece -- this file
 * only assembles them and registers outputs.
 *
 * Imports the platform stack's resources (`GhostTenantPlatformArgs`)
 * rather than re-declaring any of them: no `gcp.sql.DatabaseInstance`,
 * `gcp.storage.Bucket`, or `gcp.artifactregistry.Repository` appears
 * anywhere in this component.
 */
export class GhostTenant extends pulumi.ComponentResource {
  public readonly serviceAccountEmail: pulumi.Output<string>;
  public readonly cloudRunServiceName: pulumi.Output<string>;
  public readonly cloudRunServiceUri: pulumi.Output<string>;
  public readonly databaseName: pulumi.Output<string>;
  public readonly mediaTenantPrefix: string;
  /** MySQL statement a platform admin must run by hand to actually apply
   * `MAX_USER_CONNECTIONS` -- see `database.ts`'s long comment on why this
   * component cannot execute it itself. Wrapped as a Pulumi secret purely
   * because it names the real DB username; it contains no password. */
  public readonly maxUserConnectionsStatement: pulumi.Output<string>;

  constructor(name: string, args: GhostTenantArgs, opts?: pulumi.ComponentResourceOptions) {
    super('ghostPlatform:tenant:GhostTenant', name, {}, opts);

    validateTenantName(args.tenantName);
    const sqlIdentifier = args.tenantName.replace(/-/g, '_');
    const region = args.region ?? DEFAULT_REGION;
    const maxInstanceCount = args.maxInstanceCount ?? DEFAULT_MAX_INSTANCE_COUNT;
    const maxUserConnections = args.maxUserConnections ?? DEFAULT_MAX_USER_CONNECTIONS;

    const serviceAccount = createServiceAccount(this, args.tenantName);

    const db = createTenantDatabase(
      this,
      args.tenantName,
      sqlIdentifier,
      args.platform.dbInstanceConnectionName,
      serviceAccount,
      maxUserConnections
    );

    const storage = createTenantStorage(
      this,
      args.tenantName,
      args.platform.mediaBucketUrl,
      serviceAccount
    );

    const image = pulumi.interpolate`${args.platform.tenantImageRepositoryDockerPath}/ghost:${args.imageDigestOrTag}`;

    const service = createCloudRunService(this, {
      tenantName: args.tenantName,
      siteUrl: args.siteUrl,
      image,
      region,
      maxInstanceCount,
      serviceAccount,
      dbInstanceConnectionName: args.platform.dbInstanceConnectionName,
      database: {
        databaseName: db.database.name,
        connectionSocketPath: db.connectionSocketPath,
        dbUserNameSecret: db.dbUserNameSecret,
        dbUserPasswordSecret: db.dbUserPasswordSecret,
      },
      storage: {
        bucketName: storage.bucketName,
        tenantPrefix: storage.tenantPrefix,
        accessKeyIdSecret: storage.accessKeyIdSecret,
        secretAccessKeySecret: storage.secretAccessKeySecret,
      },
      dependsOn: [db.dbUser, db.cloudSqlClientBinding, storage.writeBinding],
    });

    createPublicInvokerBinding(this, args.tenantName, region, service);

    this.serviceAccountEmail = serviceAccount.email;
    this.cloudRunServiceName = service.name;
    this.cloudRunServiceUri = service.uri;
    this.databaseName = db.database.name;
    this.mediaTenantPrefix = storage.tenantPrefix;
    this.maxUserConnectionsStatement = pulumi.secret(db.maxUserConnectionsStatement);

    this.registerOutputs({
      serviceAccountEmail: this.serviceAccountEmail,
      cloudRunServiceName: this.cloudRunServiceName,
      cloudRunServiceUri: this.cloudRunServiceUri,
      databaseName: this.databaseName,
    });
  }
}

// Re-exported so a caller doesn't need a second import for the value this
// component defaults `maxUserConnections` to.
export { DEFAULT_MAX_USER_CONNECTIONS } from './database';
export type { CloudRunServiceArgs } from './cloudRunService';
