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
