import * as gcp from '@pulumi/gcp';
import { tenantImageRepositoryId, region } from './config';
import { enabledApis } from './apis';

/**
 * One Artifact Registry repository for the tenant Ghost image
 * (`ghost-platform`'s `Dockerfile`, built elsewhere -- this story only
 * creates somewhere for that image to be pushed to). Every tenant runs the
 * same image (this repo's README), so there is exactly one repository here,
 * not one per tenant.
 *
 * Pushing an image into it, and the Workload Identity Federation a CI
 * pipeline would need to do that, are both explicitly out of scope for this
 * story -- see the repo README's "not push anywhere" note on `build.yml`.
 */
export const tenantImageRepository = new gcp.artifactregistry.Repository(
  'ghost-platform-tenant-repo',
  {
    location: region,
    repositoryId: tenantImageRepositoryId,
    format: 'DOCKER',
    description: 'Tenant Ghost container image, shared across every tenant',
  },
  { dependsOn: enabledApis }
);
