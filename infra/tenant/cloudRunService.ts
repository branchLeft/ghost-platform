import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

/** Platform-wide constant, not per-tenant -- see README's env var table. */
const MULTIPART_UPLOAD_THRESHOLD_BYTES = '10485760'; // 10 MiB, README's recommendation.
/** README: "Must be ≥ 5 MiB (5242880) -- S3Storage enforces this floor
 * itself." Using the floor, matching Rob's 2026-08-04 minimum-size-everything
 * decision. */
const MULTIPART_CHUNK_SIZE_BYTES = '5242880';
/** Key prefix under the bucket -- README's own example value, adopted as
 * the platform-wide constant (not per-tenant; per-tenant separation is
 * `tenantPrefix`, layered underneath this). */
const STATIC_FILE_URL_PREFIX = 'content/images';

function plainEnv(name: string, value: pulumi.Input<string>) {
  return { name, value };
}

function secretEnv(name: string, secret: gcp.secretmanager.Secret) {
  return {
    name,
    valueSource: {
      secretKeyRef: { secret: secret.secretId, version: 'latest' },
    },
  };
}

export interface CloudRunServiceArgs {
  tenantName: string;
  siteUrl: pulumi.Input<string>;
  image: pulumi.Input<string>;
  region: string;
  maxInstanceCount: number;
  serviceAccount: gcp.serviceaccount.Account;
  dbInstanceConnectionName: pulumi.Input<string>;
  database: {
    databaseName: pulumi.Input<string>;
    connectionSocketPath: pulumi.Output<string>;
    dbUserNameSecret: gcp.secretmanager.Secret;
    dbUserPasswordSecret: gcp.secretmanager.Secret;
  };
  storage: {
    bucketName: pulumi.Output<string>;
    tenantPrefix: string;
    accessKeyIdSecret: gcp.secretmanager.Secret;
    secretAccessKeySecret: gcp.secretmanager.Secret;
  };
  dependsOn: pulumi.Resource[];
}

/**
 * The tenant's Cloud Run service. Every environment variable set here is
 * cross-checked against this repo's own README env var table by name,
 * casing and `__` separator -- not copied from memory of an earlier draft
 * of that table. Variables the README marks optional/policy-level
 * (`privacy__useUpdateCheck`, `logging__transports`) are set here with the
 * README's own recommended values, since this component -- not the
 * Dockerfile -- is exactly the "deploy config" layer the README says those
 * two belong to; `mail__*` is left unset, matching the README's own
 * "out of scope, boots fine without it" guidance (no SMTP provider is
 * decided anywhere in this doc set yet).
 */
export function createCloudRunService(
  parent: pulumi.Resource,
  args: CloudRunServiceArgs
): gcp.cloudrunv2.Service {
  return new gcp.cloudrunv2.Service(
    `${args.tenantName}-service`,
    {
      name: `ghost-tenant-${args.tenantName}`,
      location: args.region,
      // Not yet a stable, freely-recreatable bootstrap resource by the time
      // this ever gets applied (a live tenant's data), so this defaults to
      // protective from day one rather than being turned on retroactively
      // after the fact the way website/infra/cloudRun.ts's comment
      // describes having to do.
      deletionProtection: true,
      template: {
        serviceAccount: args.serviceAccount.email,
        scaling: {
          // Rob's 2026-08-04 decision: minimum-size everything to start.
          // Scale-to-zero for a tenant specifically (unlike the always-on
          // marketing site) -- doc 06's runtime research measured ~1s cold
          // start against a warm image with an already-migrated DB, an
          // acceptable trade for a near-zero-traffic tenant.
          minInstanceCount: 0,
          maxInstanceCount: args.maxInstanceCount,
        },
        volumes: [
          {
            name: 'cloudsql',
            cloudSqlInstance: {
              instances: [args.dbInstanceConnectionName],
            },
          },
        ],
        containers: [
          {
            image: args.image,
            ports: {
              containerPort: 8080,
            },
            resources: {
              limits: {
                // 1-2 vCPU is doc 06's measured right-sizing assumption
                // (~120-133% CPU under a 50-concurrency homepage load,
                // meaning some but not linear multi-core use); 1 is the
                // minimum-size-everything choice for a near-zero-traffic
                // tenant, matching db-f1-micro's equivalent choice on the
                // database side.
                cpu: '1',
                // Doc 06 measured ~260-333 MiB under load; 512Mi matches
                // website/infra/cloudRun.ts's own allocation and leaves
                // comparable headroom above the measured ceiling.
                memory: '512Mi',
              },
            },
            volumeMounts: [
              {
                name: 'cloudsql',
                mountPath: '/cloudsql',
              },
            ],
            envs: [
              plainEnv('url', args.siteUrl),
              plainEnv('database__client', 'mysql'),
              // NOT `database__connection__host` -- this is a Unix socket
              // path (`/cloudsql/<connection-name>`, matching the
              // `cloudSqlInstance` volume mount above), and Ghost's mysql2
              // connection layer only recognises that as `socketPath`,
              // never derived from `host`. See `database.ts`'s
              // `connectionSocketPath` comment for how this was verified
              // against Ghost's own source, and this repo's README for the
              // corrected env var table entry.
              plainEnv('database__connection__socketPath', args.database.connectionSocketPath),
              secretEnv('database__connection__user', args.database.dbUserNameSecret),
              secretEnv('database__connection__password', args.database.dbUserPasswordSecret),
              plainEnv('database__connection__database', args.database.databaseName),
              plainEnv('storage__active', 'S3Storage'),
              plainEnv('storage__S3Storage__bucket', args.storage.bucketName),
              plainEnv('storage__S3Storage__staticFileURLPrefix', STATIC_FILE_URL_PREFIX),
              plainEnv(
                'storage__S3Storage__cdnUrl',
                pulumi.interpolate`https://storage.googleapis.com/${args.storage.bucketName}`
              ),
              plainEnv(
                'storage__S3Storage__multipartUploadThresholdBytes',
                MULTIPART_UPLOAD_THRESHOLD_BYTES
              ),
              plainEnv('storage__S3Storage__multipartChunkSizeBytes', MULTIPART_CHUNK_SIZE_BYTES),
              plainEnv('storage__S3Storage__endpoint', 'https://storage.googleapis.com'),
              // Required by the AWS SDK client, functionally unused by GCS
              // per the README's own caveat -- not independently verified
              // against a live bucket by this story either (no GCP
              // resources are applied here). Using the tenant's actual GCP
              // region as a plausible, valid-looking value rather than an
              // arbitrary placeholder.
              plainEnv('storage__S3Storage__region', args.region),
              plainEnv('storage__S3Storage__forcePathStyle', 'true'),
              plainEnv('storage__S3Storage__tenantPrefix', args.storage.tenantPrefix),
              secretEnv('storage__S3Storage__accessKeyId', args.storage.accessKeyIdSecret),
              secretEnv('storage__S3Storage__secretAccessKey', args.storage.secretAccessKeySecret),
              // Recommended platform-wide defaults (README's "Optional --
              // recommended platform-wide defaults" section). Setting
              // privacy__useUpdateCheck=false here is this component acting
              // on doc 02's flagged-but-not-yet-acted-on telemetry item
              // ("Ghost's own telemetry ping... needs a deliberate
              // default-off decision").
              plainEnv('privacy__useUpdateCheck', 'false'),
              plainEnv('logging__transports', '["stdout"]'),
            ],
            startupProbe: {
              httpGet: { path: '/' },
              periodSeconds: 10,
              timeoutSeconds: 5,
              failureThreshold: 6,
            },
            livenessProbe: {
              httpGet: { path: '/' },
              periodSeconds: 30,
              timeoutSeconds: 5,
              failureThreshold: 3,
            },
          },
        ],
      },
      // Cloud Run issues two `run.app` hostnames per service; without this,
      // BOTH stay publicly reachable and bypass the shared edge -- the
      // Global External Application LB, Cloud Armor policy and Certificate
      // Manager cert entirely (doc 12 §1's whole edge design, now in
      // production for the marketing site per that doc's "Now in
      // production" note). That isn't a theoretical gap: doc 12 §1's own
      // sandbox pass confirmed both hostnames independently, and confirmed
      // the block presents as 404, not 403 -- so a regression here doesn't
      // even look like an access-control error if someone goes looking.
      // DO NOT relax this to INGRESS_TRAFFIC_ALL. See
      // website/infra/cloudRun.ts for the same lock, applied to the
      // marketing site's own service, with the same severity of warning.
      ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
    },
    { parent, dependsOn: args.dependsOn }
  );
}

/**
 * Public invoker binding -- ingress above controls *network path* (only the
 * shared edge's serverless NEG can reach this service at all); this
 * controls *authorization* for requests that do arrive via that path. A
 * tenant's Ghost site is a public site, same as the marketing site, so this
 * mirrors website/infra/cloudRun.ts's own `website-public-invoker` binding.
 */
export function createPublicInvokerBinding(
  parent: pulumi.Resource,
  tenantName: string,
  region: string,
  service: gcp.cloudrunv2.Service
): gcp.cloudrunv2.ServiceIamMember {
  return new gcp.cloudrunv2.ServiceIamMember(
    `${tenantName}-service-public-invoker`,
    {
      location: region,
      name: service.name,
      role: 'roles/run.invoker',
      member: 'allUsers',
    },
    { parent: service }
  );
}
