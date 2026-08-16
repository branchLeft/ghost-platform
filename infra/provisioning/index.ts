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
 *
 * State location and secrets provider are independent: this bucket holds
 * state only, and the workflow that provisions a stack into it now selects
 * the passphrase provider unconditionally, with no GCP KMS dependency left
 * anywhere in this file's output. Retiring per-tenant GCS buckets in favour
 * of Hetzner Object Storage is separate, later work with its own
 * prerequisites, not something this file's secrets-provider choice is
 * coupled to.
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
 *
 * `roles/artifactregistry.reader` is not derivable that way, and its absence
 * cost a failed first apply: Cloud Run checks at deploy time that the *caller*
 * can read the image, so the deployer needs it even though nothing in the
 * tenant program declares an Artifact Registry resource. Deriving roles from
 * declared resources cannot see a caller-side permission — the same blind spot
 * that hid `iam.serviceAccounts.actAs` (RUNBOOK-bootstrap.md P7).
 *
 * Project-level rather than scoped to the one repository: granting at the
 * repository would need `artifactregistry.repositories.setIamPolicy`, which
 * this provisioning identity deliberately does not hold. The scope this gives
 * up is small — every tenant runs the same image, so there is nothing in this
 * registry one tenant may read and another may not.
 */
const deployerProjectRoles: Array<[string, string]> = [
  ['cloudsql-editor', 'roles/cloudsql.editor'],
  ['run-developer', 'roles/run.developer'],
  ['artifactregistry-reader', 'roles/artifactregistry.reader'],
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
