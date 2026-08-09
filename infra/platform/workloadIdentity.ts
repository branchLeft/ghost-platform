import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { githubRepo, workloadIdentityPoolId } from './config';
import { deployerSa } from './serviceAccounts';
import { enabledApis } from './apis';

/**
 * Workload Identity Federation for this repo's GitHub Actions runs, so CI can
 * apply this stack with a short-lived, exchanged token and no long-lived
 * service-account key ever exists.
 *
 * Same construction as website/infra/workloadIdentity.ts, which has been
 * running this project's production deploys since 2026-08-01 -- but with its
 * own pool (see config.ts: `github-actions` is already taken in
 * `branchleft-prod`) and its own repository condition.
 */
export const pool = new gcp.iam.WorkloadIdentityPool(
  'ghost-platform-gha-pool',
  {
    workloadIdentityPoolId,
    // Max 32 characters (GCP API limit); this is 31.
    displayName: 'GitHub Actions (ghost-platform)',
    description: 'CI identity federation for the branchLeft/ghost-platform repo',
  },
  { dependsOn: enabledApis }
);

export const provider = new gcp.iam.WorkloadIdentityPoolProvider(
  'ghost-platform-gha-provider',
  {
    workloadIdentityPoolId: pool.workloadIdentityPoolId,
    workloadIdentityPoolProviderId: 'github',
    displayName: 'GitHub',

    // `google.subject` is mandatory. `attribute.repository` is what the
    // principalSet binding below matches on -- an attribute has to be
    // *mapped* before it can be referenced in a principalSet; naming it in
    // the condition is not enough. `attribute.ref` is not referenced by any
    // principalSet today, and is mapped anyway so the branch is visible on
    // the federated principal in audit logs, and so narrowing the
    // impersonation binding to a branch later is a one-line change rather
    // than a provider update.
    attributeMapping: {
      'google.subject': 'assertion.sub',
      'attribute.repository': 'assertion.repository',
      'attribute.ref': 'assertion.ref',
    },

    // Restricts the token exchange itself. This is the outer of two
    // independent gates: a caller failing this cannot complete the STS
    // exchange against this pool at all, whatever any service account's IAM
    // policy says.
    //
    // **The branch clause is not belt-and-braces, it is load-bearing.** An
    // earlier revision conditioned on the repository alone, reasoning that
    // fork PRs get no OIDC token (true, and still true) and that the
    // workflow file's `id-token: write` scoping was the real control. That
    // missed the case that matters: anyone with push access to *any branch*
    // of this repo could add a workflow on their own branch requesting
    // `id-token: write`, read `GCP_WORKLOAD_IDENTITY_PROVIDER` and
    // `GCP_DEPLOYER_SA_EMAIL` (repo *variables*, deliberately not secrets,
    // so plainly readable), and impersonate the deployer service account --
    // no PR, no review, no merge to `main`. This repo has no branch
    // protection on `main` to fall back on either: the plan it is on does
    // not offer it while the repo is private (`gh api
    // repos/.../branches/main/protection` returns 403 "Upgrade to GitHub
    // Pro or make this repository public"), so this condition is the gate.
    //
    // `refs/heads/main` is the documented shape of the `ref` claim, and the
    // interaction with the deploy job's `environment:` key was specifically
    // checked rather than assumed -- referencing an environment rewrites the
    // `sub` claim to `repo:OWNER/REPO:environment:NAME`, which could
    // plausibly have displaced the branch information entirely and broken
    // the very first CI run after the platform owner's bootstrap. GitHub's own worked
    // example of a token from an environment-referencing job shows `sub`
    // and `ref` side by side, with `ref: "refs/heads/main"` still present.
    // Conditioning on `assertion.ref` rather than on `sub` is what makes
    // that immaterial here.
    //
    // Cost, accepted: a future pull-request `pulumi preview` job cannot
    // federate through this provider, since its `ref` is a PR head branch.
    // That is the right constraint rather than a regression -- such a job
    // should not be running as the *deployer* identity anyway. It gets its
    // own provider in this same pool (they are free) with its own condition,
    // federating to a separate read-only service account.
    //
    // Next tightening available if wanted, deliberately not taken: pin
    // `assertion.workflow_ref` to this exact workflow file at `main`. It is
    // stricter still, and brittle -- renaming the workflow file silently
    // breaks every deploy.
    attributeCondition: `assertion.repository == "${githubRepo}" && assertion.ref == "refs/heads/main"`,

    oidc: {
      issuerUri: 'https://token.actions.githubusercontent.com',
    },
  }
);

/**
 * The inner gate: which federated principals may impersonate the deployer SA.
 *
 * `principalSet://.../attribute.repository/<repo>` matches every token from
 * that repository that got through the provider condition above.
 *
 * `roles/iam.workloadIdentityUser` is the correct role and was checked, not
 * assumed: `gcloud iam roles describe roles/iam.workloadIdentityUser` returns
 * exactly iam.serviceAccounts.{get,getAccessToken,getOpenIdToken,list}.
 * `getAccessToken` is the one `google-github-actions/auth` needs -- with a
 * `service_account` input it performs the STS exchange and then calls
 * `iamcredentials.googleapis.com/v1/.../generateAccessToken` on the SA.
 *
 * Note `pool.name` (the full `projects/<number>/locations/global/
 * workloadIdentityPools/<id>` resource name), not `pool.workloadIdentityPoolId`
 * -- a principalSet built from the bare ID is syntactically accepted and
 * matches nothing, which fails at token-exchange time rather than at apply
 * time.
 */
export const deployerImpersonation = new gcp.serviceaccount.IAMMember(
  'ghost-platform-gha-can-impersonate-deployer',
  {
    serviceAccountId: deployerSa.name,
    role: 'roles/iam.workloadIdentityUser',
    member: pulumi.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.repository/${githubRepo}`,
  }
);

/**
 * Consumed by the `google-github-actions/auth` step in
 * `.github/workflows/infra-platform-ci.yml`, via the repo variables the platform owner sets
 * from `pulumi stack output` (RUNBOOK-bootstrap.md). Not committed to this
 * repo: the provider's resource name embeds the GCP project *number*, which
 * is one more infrastructure identifier than this public-bound repo needs to
 * carry.
 */
export const workloadIdentityProvider = provider.name;
