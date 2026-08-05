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

    // Only the two claims anything downstream uses. `google.subject` is
    // mandatory. `attribute.repository` is what the principalSet binding
    // below matches on -- an attribute has to be *mapped* before it can be
    // referenced in a principalSet, mapping it in the condition is not
    // enough.
    attributeMapping: {
      'google.subject': 'assertion.sub',
      'attribute.repository': 'assertion.repository',
    },

    // Restricts the token exchange itself to this one repository. This is the
    // outer of two independent gates: even a caller holding a valid GitHub
    // OIDC token from some other repo cannot complete the STS exchange
    // against this pool at all.
    //
    // Deliberately scoped to the repository and NOT additionally to
    // `refs/heads/main`. A branch condition would be stricter, and is the
    // obvious next tightening -- but it would also block the pull-request
    // `pulumi preview` job that is the natural follow-up to this story
    // (website/infra runs exactly that, from PR head branches), so adding it
    // now would have to be undone almost immediately. Recording the tradeoff
    // rather than leaving the looser condition unexplained.
    //
    // What this does mean today: *any* workflow in this repo that requests
    // `id-token: write` can assume the deployer SA. The workflow file is the
    // real control there, which is why `infra-platform-ci.yml` grants
    // `id-token: write` at job level on the deploy job only, and why the
    // fork-PR case cannot reach it (GitHub does not issue an OIDC token to a
    // fork's `pull_request` run whatever the workflow asks for).
    attributeCondition: `assertion.repository == "${githubRepo}"`,

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
 * `.github/workflows/infra-platform-ci.yml`, via the repo variables Rob sets
 * from `pulumi stack output` (RUNBOOK-bootstrap.md). Not committed to this
 * repo: the provider's resource name embeds the GCP project *number*, which
 * is one more infrastructure identifier than this public-bound repo needs to
 * carry.
 */
export const workloadIdentityProvider = provider.name;
