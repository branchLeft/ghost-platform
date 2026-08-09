import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import {
  projectId,
  region,
  tenantName,
  tenantGithubRepo,
  stateBucketName,
  deployerServiceAccountId,
  workloadIdentityPoolId,
  secretsKmsKeyId,
  provisioningServiceAccountEmail,
  platformDbInstanceConnectionName,
  platformTenantImageRepositoryDockerPath,
  platformMediaBucketUrl,
} from './config';

/**
 * One tenant's deploy identity and state backend, created by the platform
 * rather than by the tenant repo — a Pulumi program cannot create the identity
 * it runs as, and the roles needed to try are the ones a deploy identity must
 * never hold.
 *
 * No API enablements: services are enabled once by the platform stack, which
 * is what keeps `roles/serviceusage.serviceUsageAdmin` off every tenant
 * deployer.
 */

/**
 * This tenant's own state bucket.
 *
 * Not a prefix on the shared bucket. An object-name prefix condition is
 * enforced exactly for reads and writes but can never grant
 * `storage.objects.list`, which evaluates against the bucket — and the
 * filestate backend resolves a stack by listing, so a prefix-confined deployer
 * fails with `no stack named '<name>' found`, a missing-stack error rather
 * than a permission error. A bucket per tenant makes a plain bucket-scoped
 * `roles/storage.objectAdmin` correctly confined, and stops any tenant
 * enumerating another's stacks.
 */
export const stateBucket = new gcp.storage.Bucket(`${tenantName}-pulumi-state`, {
  name: stateBucketName,
  location: region,
  uniformBucketLevelAccess: true,
  publicAccessPrevention: 'enforced',
  // A checkpoint is the only record of what this tenant's infrastructure is.
  versioning: { enabled: true },
});

export const deployerSa = new gcp.serviceaccount.Account(`${tenantName}-deployer-sa`, {
  accountId: deployerServiceAccountId,
  displayName: `Ghost tenant ${tenantName} - CI/CD identity`,
});

const deployerMember = pulumi.interpolate`serviceAccount:${deployerSa.email}`;

export const pool = new gcp.iam.WorkloadIdentityPool(`${tenantName}-gha-pool`, {
  workloadIdentityPoolId,
  displayName: 'GitHub Actions', // 32-char GCP limit
  description: `CI identity federation for ${tenantGithubRepo}`,
});

export const provider = new gcp.iam.WorkloadIdentityPoolProvider(`${tenantName}-gha-provider`, {
  workloadIdentityPoolId: pool.workloadIdentityPoolId,
  workloadIdentityPoolProviderId: 'github',
  displayName: 'GitHub',
  attributeMapping: {
    'google.subject': 'assertion.sub',
    'attribute.repository': 'assertion.repository',
    'attribute.ref': 'assertion.ref',
  },
  // The branch clause is load-bearing, not belt-and-braces: without it anyone
  // with push access to any branch could add a workflow requesting
  // `id-token: write` and impersonate this deployer with no PR and no merge.
  attributeCondition: `assertion.repository == "${tenantGithubRepo}" && assertion.ref == "refs/heads/main"`,
  oidc: { issuerUri: 'https://token.actions.githubusercontent.com' },
});

export const deployerImpersonation = new gcp.serviceaccount.IAMMember(
  `${tenantName}-gha-can-impersonate-deployer`,
  {
    serviceAccountId: deployerSa.name,
    role: 'roles/iam.workloadIdentityUser',
    // `pool.name`, not the bare pool id: a principalSet built from the id is
    // syntactically accepted, matches nothing, and fails at token-exchange
    // time rather than at apply time.
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.repository/${tenantGithubRepo}`,
  }
);

/**
 * Project roles for the tenant deployer, derived from what a `GhostTenant`
 * instantiation actually creates.
 *
 * `roles/cloudsql.editor` and not admin: editor holds
 * `cloudsql.users.{get,list}` and neither `users.create` nor
 * `instances.delete`, so a tenant's CI can never create its own DB user and
 * can never reach the instance every tenant's data sits on. Creating the user
 * is this provisioning identity's job, once.
 *
 * `roles/serviceusage.serviceUsageAdmin` is deliberately absent — the tenant
 * program no longer enables APIs, which is the whole reason it used to be
 * here. That role also permits changing project quotas and consumer policies.
 */
const deployerProjectRoles: Array<[string, string]> = [
  ['cloudsql-editor', 'roles/cloudsql.editor'],
  ['run-developer', 'roles/run.developer'],
];

for (const [suffix, role] of deployerProjectRoles) {
  new gcp.projects.IAMMember(`${tenantName}-deployer-${suffix}`, {
    project: projectId,
    role,
    member: deployerMember,
  });
}

/** The deployer's own state bucket, and nothing else's. */
export const deployerStateBucketAccess = new gcp.storage.BucketIAMMember(
  `${tenantName}-deployer-state-access`,
  {
    bucket: stateBucket.name,
    role: 'roles/storage.objectAdmin',
    member: deployerMember,
  }
);

/**
 * The provisioning identity's own access to the bucket it just created. It
 * holds bucket administration but no object permission anywhere, so without
 * this it could create the tenant's backend and then not write the tenant's
 * first checkpoint into it.
 */
export const provisionerStateBucketAccess = new gcp.storage.BucketIAMMember(
  `${tenantName}-provisioner-state-access`,
  {
    bucket: stateBucket.name,
    role: 'roles/storage.objectAdmin',
    member: `serviceAccount:${provisioningServiceAccountEmail}`,
  }
);

/**
 * Lets the tenant's CI decrypt its own stack's data key. Granted on the key,
 * never as a project-level `roles/cloudkms.admin` — that would let a deploy
 * pipeline rewrite who may decrypt its own secrets.
 *
 * This is a Pulumi resource here and a `gcloud` step in the platform runbook
 * for a real reason: the platform stack cannot grant itself access to the key
 * it must decrypt before it can apply anything, but this program is a
 * *different* stack granting a *different* identity, so the chicken-and-egg
 * does not arise.
 */
export const deployerKmsAccess = new gcp.kms.CryptoKeyIAMMember(
  `${tenantName}-deployer-kms-decrypt`,
  {
    cryptoKeyId: secretsKmsKeyId,
    role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
    member: deployerMember,
  }
);

// Consumed by the provisioning workflow: the first three become repo
// variables on the generated repo, the rest become that stack's config.
export const githubActionsWorkloadIdentityProvider = provider.name;
export const githubActionsDeployerServiceAccountEmail = deployerSa.email;
export const pulumiStateBucket = stateBucket.name;
export const tenantStackConfig = pulumi.output({
  platformDbInstanceConnectionName,
  platformTenantImageRepositoryDockerPath,
  platformMediaBucketUrl,
});
