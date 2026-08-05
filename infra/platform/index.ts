import * as pulumi from '@pulumi/pulumi';
import { dbInstance } from './database';
import { tenantImageRepository } from './registry';
import { mediaBucket } from './mediaBucket';
import { region, projectId } from './config';
import { workloadIdentityProvider } from './workloadIdentity';
import { deployerServiceAccountEmail } from './serviceAccounts';
import './apis';
// Imported for its side effects only, and that is the point: the platform
// provisioning DB user and its Secret Manager entry must be *created*, but
// nothing about them -- name, password, secret ID, secret version -- may leave
// this stack. See provisioningUser.ts's header for the full privilege
// analysis; the short version is that it is a cross-tenant-privileged
// credential with no consumer yet, so there is nothing to export it to and
// every export would only widen where it can be picked up from.
import './provisioningUser';

// Everything a future tenant-provisioning story needs to point at, without
// this stack knowing anything about any tenant. No hostname, tenant name,
// logical database, DB user, or credential appears anywhere in this program
// -- see the per-file comments for why each of those is deliberately absent.

export const dbInstanceConnectionName = dbInstance.connectionName;
export const dbInstanceSelfLink = dbInstance.selfLink;

// Adversarial review (round 2) caught this: `tenantImageRepository.name` is
// the bare repository ID (`ghost-platform-tenant`), *not* a pushable
// registry URL -- confirmed against @pulumi/gcp's own field docs ("The name
// of the repository, for example: repo1"). Exporting that under a `...Url`
// name type-checked cleanly and would have failed silently later, only when
// a future story tried to build a docker push target out of it. Constructed
// properly here instead, mirroring website/infra/config.ts's
// `dockerPushTarget` pattern -- this is the repository path only (no image
// name), since which image name the tenant container uses is a later
// story's decision, not this platform stack's.
export const tenantImageRepositoryDockerPath = pulumi.interpolate`${region}-docker.pkg.dev/${projectId}/${tenantImageRepository.repositoryId}`;

export const mediaBucketUrl = mediaBucket.url;
export const mediaBucketSelfLink = mediaBucket.selfLink;

// CI identity, for the `google-github-actions/auth` step in
// .github/workflows/infra-platform-ci.yml. These two values are the entire
// contract between this stack and that workflow -- Rob copies them into the
// repo variables GCP_WORKLOAD_IDENTITY_PROVIDER and GCP_DEPLOYER_SA_EMAIL
// after the bootstrap apply (RUNBOOK-bootstrap.md), rather than either value
// being committed here. The provider name embeds the GCP project *number*,
// which is one more infrastructure identifier than a repo bound for public
// needs to carry in its source.
export const githubActionsWorkloadIdentityProvider = workloadIdentityProvider;
export const githubActionsDeployerServiceAccountEmail = deployerServiceAccountEmail;
