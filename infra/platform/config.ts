import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config('gcp');

export const projectId = gcpConfig.require('project');

// europe-west1 is a hard requirement, not a default -- doc 02's UK/EU data
// residency decision, inherited from website/infra and reaffirmed platform-wide
// in OPEN-QUESTIONS.md #13.
export const region = config.get('region') ?? 'europe-west1';

// Fixed platform-level identifiers. Not stack config, because there is
// exactly one of each of these per platform (not per environment) -- this
// program only ever has one stack ("platform"), unlike website/infra's
// per-environment imageTag pattern.
export const dbInstanceName = 'ghost-platform-db';
export const tenantImageRepositoryId = 'ghost-platform-tenant';
export const mediaBucketName = `${projectId}-ghost-platform-media`;

// The one GitHub repository allowed to federate into this project's deployer
// service account, as the exact `owner/repo` string GitHub puts in the
// `repository` claim of its OIDC token.
//
// Deliberately a hardcoded constant, not `config.require('githubRepo')` the
// way website/infra does it. This is a security boundary, not a knob: the
// value is the sole thing standing between "only this repo's Actions runs can
// assume the deployer SA" and "some other repo's can". A stack-config value
// can be changed with `pulumi config set` and no code review; a constant here
// cannot be changed without a diff someone has to approve. It also matches
// this file's existing pattern -- there is exactly one of these per platform,
// so it is a fixed identifier, not stack configuration.
//
// Casing matters and is not cosmetic. The condition is a CEL string equality
// against GitHub's claim, which carries the repository's canonical casing.
// Take that casing from the API (`gh api repos/<owner>/<repo> --jq
// .full_name`), never from the git remote URL, which GitHub serves
// case-insensitively.
export const githubRepo = 'branchLeft/ghost-platform';

// Workload Identity Pool ID for this repo's CI identity.
//
// **Not `github-actions`**, even though that is the obvious name: pool IDs
// are unique per project, and the marketing site's stack already holds a
// pool with that exact ID. Declaring a second resource with the same ID
// here would collide on the first apply.
//
// A separate pool rather than a second provider inside that pool: a provider
// added to it would live in the other stack's Pulumi state, making this
// repo's CI credentials a dependency of a different repo's stack. Pools are
// free, so the coupling buys nothing.
export const workloadIdentityPoolId = 'ghost-platform-gha';
