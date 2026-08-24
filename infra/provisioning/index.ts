import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import {
  projectId,
  tenantName,
  tenantGithubRepo,
  deployerServiceAccountId,
  workloadIdentityPoolId,
  platformDbInstanceConnectionName,
  platformTenantImageRepositoryDockerPath,
  platformMediaBucketUrl,
} from './config';

/*
 * One tenant's deploy identity, created by the platform rather than by the
 * tenant repo — a Pulumi program cannot create the identity it runs as, and
 * the roles needed to try are the ones a deploy identity must never hold.
 *
 * No API enablements: services are enabled once by the platform stack, which
 * is what keeps `roles/serviceusage.serviceUsageAdmin` off every tenant
 * deployer.
 *
 * **No per-tenant state bucket, and that is the change here.** A tenant's
 * Pulumi state lives in a Hetzner Object Storage bucket that holds tenant
 * stacks and nothing else, addressed by project name; the backend already
 * exists, so a newly provisioned tenant acquires no GCP resource for its state
 * at all. Deliberately not the estate's own `branchleft-pulumi-state`, which
 * holds the checkpoint the production hcloud token lives in — the S3
 * credential is not scoped per stack, and buckets are free at the margin.
 *
 * The pattern that replaces existed for a GCS-specific reason that does not
 * carry over: an object-name prefix condition is enforced for reads and writes
 * but can never grant `storage.objects.list`, which evaluates against the
 * bucket, and the filestate backend resolves a stack by listing — so a
 * prefix-confined deployer failed with `no stack named '<name>' found`. A
 * bucket per tenant was the only way to make a bucket-scoped role correctly
 * confined.
 *
 * What that costs on Hetzner is stated rather than glossed: the S3 credential
 * that reaches the tenant bucket reaches every tenant stack in it, so
 * tenant-to-tenant state isolation is no longer enforced by the credential.
 * Scoping it needs the same per-key bucket policy the media-isolation decision
 * is waiting on, and it is tracked as its own item rather than assumed here.
 *
 * The GCP deploy identity below is the remaining GCP-era shape in this file.
 * It is retired with the provisioning-flow rewrite, not here: a tenant repo
 * that already holds a live GCP-backed pipeline keeps working until its own
 * migration story moves it.
 */

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

// Consumed by the provisioning workflow: the first two become repo variables
// on the generated repo, the rest become that stack's config.
export const githubActionsWorkloadIdentityProvider = provider.name;
export const githubActionsDeployerServiceAccountEmail = deployerSa.email;
export const tenantStackConfig = pulumi.output({
  platformDbInstanceConnectionName,
  platformTenantImageRepositoryDockerPath,
  platformMediaBucketUrl,
});
