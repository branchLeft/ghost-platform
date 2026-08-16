import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config('gcp');

export const projectId = gcpConfig.require('project');
export const region = config.get('region') ?? 'europe-west1';

/**
 * Per-tenant inputs. Every one is `require`: this program creates a tenant's
 * only identity, and a defaulted value here would silently produce a second
 * tenant sharing a first tenant's service account or state.
 */
export const tenantName = config.require('tenantName');

/** `<org>/<repo>` exactly as GitHub spells it in the OIDC `repository` claim. */
export const tenantGithubRepo = config.require('tenantGithubRepo');

/**
 * Supplied, never derived. Bucket names are globally visible, so what a name
 * discloses is a platform-wide decision rather than this program's to invent
 * — the codename scheme that will supply it is a separate decision. Deriving
 * it from `tenantName` here would hardcode "the bucket name leaks the tenant
 * name" before that decision is made.
 */
export const stateBucketName = config.require('stateBucketName');

/** GCP identifiers, unique per project rather than per repo. */
export const deployerServiceAccountId = config.require('deployerServiceAccountId');
export const workloadIdentityPoolId = config.require('workloadIdentityPoolId');

/**
 * Platform values this program only passes through, into the tenant stack's
 * config. Read from config rather than a `StackReference` for the same reason
 * the tenant program stopped using one — a reference cannot cross backends,
 * and this program writes state to a different bucket than the tenant's.
 */
export const platformDbInstanceConnectionName = config.require('platformDbInstanceConnectionName');
export const platformTenantImageRepositoryDockerPath = config.require(
  'platformTenantImageRepositoryDockerPath'
);
export const platformMediaBucketUrl = config.require('platformMediaBucketUrl');

/**
 * The identity applying this program. Needed as a plain string because the
 * program grants it object access to the bucket it creates, and a resource
 * cannot ask who is applying it.
 */
export const provisioningServiceAccountEmail =
  config.get('provisioningServiceAccountEmail') ??
  `ghost-tenant-provisioner@${projectId}.iam.gserviceaccount.com`;
