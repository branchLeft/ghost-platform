import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as random from '@pulumi/random';
import { secretWithValue } from './secrets';

/**
 * Sensible default for MySQL's per-user `MAX_USER_CONNECTIONS`, applied to
 * every tenant unless a caller overrides it (doc 02: "Per-tenant connection
 * limits... A per-tenant DB user... bounds *what* a tenant can reach but not
 * *how much* of the shared instance they can consume").
 *
 * Reasoning, not a verified live measurement: `infra/platform/database.ts`
 * runs `db-f1-micro`, shared by however many tenants the platform has at any
 * given time -- currently a small number of low-traffic outlets, per
 * OPEN-QUESTIONS.md #4 (this repo doesn't name tenants -- see this repo's
 * own README on why). This story has no live instance to query
 * `SHOW VARIABLES LIKE 'max_connections'` against, so the instance's actual
 * ceiling is not confirmed here -- flagging that gap rather than asserting a number this
 * story didn't check. 10 is chosen as a value that comfortably covers one
 * Ghost container's own connection pool (including a burst of concurrent
 * cold-start/horizontal-replica connections, per doc 06's confirmation that
 * concurrent replicas against one DB are a supported deployment shape) while
 * still bounding a single misbehaving or attacked tenant to a small slice of
 * a small instance. Revisit with a real number once doc 08's monitoring
 * exists to justify one, same as this doc set's other "recommended default,
 * not load-bearing" values (e.g. doc 09's 30-day media-version window).
 */
export const DEFAULT_MAX_USER_CONNECTIONS = 10;

interface DatabaseResult {
  database: gcp.sql.Database;
  dbUser: gcp.sql.User;
  dbUserNameSecret: gcp.secretmanager.Secret;
  dbUserPasswordSecret: gcp.secretmanager.Secret;
  /**
   * Unix socket path Cloud Run mounts once the `cloudSqlInstance` volume is
   * attached (`cloudRunService.ts`) -- the value for
   * `database__connection__socketPath`, **not** `database__connection__host`.
   * An earlier version of this component wired this into `host`, which is
   * wrong: verified directly against Ghost's own source
   * (`ghost/core/core/server/data/db/connection.js` passes `dbConfig.connection`
   * straight into `knex()`/mysql2 with no `socketPath`-from-`host` handling
   * of any kind, and `ghost/core/core/shared/config/utils.ts`'s
   * `sanitizeDatabaseProperties` -- the only place Ghost post-processes
   * `database.connection` -- touches `client`/`filename`/`host`/`user`/
   * `password`/`database` and never `socketPath`; a repo-wide
   * `grep -rn socketPath ghost/core` excluding tests returns zero matches).
   * mysql2 treats `host` as a TCP hostname unless it is literally
   * `'localhost'`; a Cloud SQL connection-name-shaped path
   * (`/cloudsql/project:region:instance`) set as `host` resolves as a DNS
   * lookup and fails with `ENOTFOUND` -- the service would deploy
   * successfully and then crash-loop, exactly the "applies cleanly, does
   * nothing" failure shape this programme keeps hitting. `socketPath` is
   * mysql2's actual, distinct connection option for Unix-socket connections
   * and is passed through unmodified by the same code path.
   */
  connectionSocketPath: pulumi.Output<string>;
  cloudSqlClientBinding: gcp.projects.IAMMember;
  /**
   * The exact statement a platform admin needs to run to actually apply
   * `MAX_USER_CONNECTIONS` -- see the long comment on `maxUserConnections`
   * below for why this component produces the statement but cannot execute
   * it itself.
   */
  maxUserConnectionsStatement: pulumi.Output<string>;
  maxUserConnections: number;
}

/**
 * The tenant's logical database, dedicated DB user, and the IAM grant that
 * lets the tenant's service account open a connection to the *shared*
 * instance at all (doc 02: "shared Cloud SQL instance(s), one logical
 * database + one dedicated DB user per tenant"). Provisions nothing on the
 * instance itself -- `dbInstanceConnectionName` is imported from
 * `infra/platform`, never re-declared.
 */
export function createTenantDatabase(
  parent: pulumi.Resource,
  tenantName: string,
  sqlIdentifier: string,
  dbInstanceConnectionName: pulumi.Input<string>,
  serviceAccount: gcp.serviceaccount.Account,
  maxUserConnections: number = DEFAULT_MAX_USER_CONNECTIONS
): DatabaseResult {
  const connectionNameParts = pulumi.output(dbInstanceConnectionName).apply((cn) => {
    // Documented, stable format: `{project}:{region}:{instance}` (confirmed
    // against Google's own Cloud Run + Cloud SQL connection guide). Splitting
    // it is how this component recovers the instance's bare resource name
    // and project without infra/platform exporting either separately --
    // this story's brief lists dbInstanceConnectionName/dbInstanceSelfLink as
    // the platform stack's fixed export surface, and changing infra/platform
    // itself is out of scope for this story.
    const parts = cn.split(':');
    if (parts.length !== 3) {
      throw new Error(
        `GhostTenant: dbInstanceConnectionName "${cn}" doesn't match the documented ` +
          `"{project}:{region}:{instance}" format.`
      );
    }
    return { project: parts[0], region: parts[1], instance: parts[2] };
  });

  const instanceShortName = connectionNameParts.apply((p) => p.instance);
  const projectId = connectionNameParts.apply((p) => p.project);

  const database = new gcp.sql.Database(
    `${tenantName}-db`,
    {
      name: `ghost_${sqlIdentifier}`,
      instance: instanceShortName,
      // Matches the instance's own deletion posture (database.ts on the
      // platform stack sets deletionProtection on the whole instance) --
      // a tenant's logical database shouldn't be droppable by a routine
      // `pulumi up` diff either, once real data exists in it.
      deletionPolicy: 'ABANDON',
    },
    { parent }
  );

  // Per doc 02's "Secrets" section: DB credentials extend
  // website/infra/secrets.ts's Secret Manager pattern. That file has no
  // precedent for *generating* a credential (its two secrets are both
  // `config.requireSecret`, supplied by a human) -- @pulumi/random's
  // RandomPassword is the standard Pulumi-ecosystem way to generate one
  // without ever having the plaintext pass through this program's own state
  // as anything other than a Pulumi secret-tracked Output, and is already a
  // documented dependency of @pulumi/gcp's own `gcp.sql.User` examples.
  const dbUserPassword = new random.RandomPassword(
    `${tenantName}-db-password`,
    {
      length: 32,
      special: true,
      // Excludes quote/backslash/semicolon-shaped characters -- not because
      // the value ever passes through a shell or SQL string literal (it
      // reaches Ghost as a Cloud Run env var sourced directly from Secret
      // Manager, and reaches MySQL as a bind parameter via mysql2, neither
      // of which string-interpolates it) but because there is no benefit to
      // the risk of a character set that behaves differently across two
      // client libraries neither of which this story exercises against a
      // live instance.
      overrideSpecial: '-_.~',
    },
    { parent }
  );

  const dbUser = new gcp.sql.User(
    `${tenantName}-db-user`,
    {
      name: `ghost_${sqlIdentifier}`,
      instance: instanceShortName,
      password: dbUserPassword.result,
    },
    { parent, dependsOn: [database] }
  );

  // README's env var table lists `database__connection__user`'s Origin as
  // "Secret Manager", not "Deploy config" -- so the username, not just the
  // password, is stored and read back the same way, matching the table
  // exactly rather than treating the username as safe to inline because it
  // isn't secret-shaped on its own.
  const dbUserNameSecret = secretWithValue(
    parent,
    `${tenantName}-db-username`,
    `ghost-tenant-${tenantName}-db-username`,
    dbUser.name,
    serviceAccount.email
  ).secret;

  const dbUserPasswordSecret = secretWithValue(
    parent,
    `${tenantName}-db-password-secret`,
    `ghost-tenant-${tenantName}-db-password`,
    dbUserPassword.result,
    serviceAccount.email
  ).secret;

  // `roles/cloudsql.client` is what Google's own "Connect to Cloud SQL for
  // MySQL from Cloud Run" doc states the runtime service account needs to
  // use Cloud Run's built-in Cloud SQL connection (the Auth-Proxy-backed
  // Unix socket wired up in `cloudRunService.ts`) -- verified against that
  // doc directly, not assumed from the role's name. Scoped via an IAM
  // Condition to this specific instance's resource name rather than granted
  // project-wide: with exactly one shared instance today this doesn't yet
  // separate one tenant from another (every tenant needs access to the same
  // instance), but it does mean a tenant later graduated to a dedicated
  // instance (doc 01's tiering) doesn't retain standing access to the
  // *shared* one purely because this binding was never instance-scoped.
  // Condition expression format confirmed against Google's Cloud SQL IAM
  // Conditions documentation for MySQL.
  const cloudSqlClientBinding = new gcp.projects.IAMMember(
    `${tenantName}-cloudsql-client`,
    {
      project: projectId,
      role: 'roles/cloudsql.client',
      member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
      condition: {
        title: `${tenantName}-shared-instance-only`,
        description: `Restricts roles/cloudsql.client to the one shared Cloud SQL instance this tenant's database lives on.`,
        expression: pulumi.interpolate`resource.name == "projects/${projectId}/instances/${instanceShortName}" && resource.service == "sqladmin.googleapis.com"`,
      },
    },
    { parent }
  );

  const connectionSocketPath = pulumi.interpolate`/cloudsql/${dbInstanceConnectionName}`;

  // **What this component does NOT apply, stated plainly rather than
  // silently skipped.** Doc 02 decides MAX_USER_CONNECTIONS should be set
  // per tenant user at provisioning. Setting it requires a MySQL `ALTER
  // USER ... WITH MAX_USER_CONNECTIONS n` (or an equivalent `GRANT ...
  // WITH MAX_USER_CONNECTIONS`) -- the Cloud SQL Admin API's `User`
  // resource (what `gcp.sql.User` above wraps) has no field for it, checked
  // directly against @pulumi/gcp's generated type for `gcp.sql.User`, which
  // exposes name/instance/password/type/databaseRoles and nothing
  // connection-limit-shaped. Running that ALTER USER statement needs a
  // *privileged* MySQL connection (MySQL's CREATE USER privilege, or
  // equivalent), and this architecture deliberately has no such credential
  // anywhere: infra/platform/database.ts leaves the instance's root
  // password unset on purpose ("lets Cloud SQL generate one internally that
  // this program never reads, stores, or has any use for"), and granting
  // the *tenant's own* user elevated privileges just to let it alter itself
  // would mean every tenant's DB user could also read/alter every other
  // tenant's -- the exact isolation doc 02 exists to prevent. Manufacturing
  // a one-off admin credential inside *this* per-tenant component would
  // also be wrong on its own terms: N independent tenant stacks (per doc
  // 03's repo split) would each try to own the same shared-instance
  // credential, which is a platform-level concern, not a tenant-level one.
  //
  // Net: MAX_USER_CONNECTIONS is a genuine gap in what this component can
  // automate, not an oversight. What it produces instead is the exact
  // statement to run and the decided value (`maxUserConnections` above) --
  // apply it by hand via `gcloud sql connect` (or the Cloud SQL Auth Proxy)
  // as a platform admin, immediately after `pulumi up` creates this user,
  // and reconsider a proper fix (e.g. a platform-owned, narrowly-scoped
  // provisioning credential added to infra/platform in its own story) if
  // this manual step turns out to be a recurring paper cut at real tenant
  // volume.
  const maxUserConnectionsStatement = dbUser.name.apply(
    (name) => `ALTER USER '${name}'@'%' WITH MAX_USER_CONNECTIONS ${maxUserConnections};`
  );

  return {
    database,
    dbUser,
    dbUserNameSecret,
    dbUserPasswordSecret,
    connectionSocketPath,
    cloudSqlClientBinding,
    maxUserConnectionsStatement,
    maxUserConnections,
  };
}
