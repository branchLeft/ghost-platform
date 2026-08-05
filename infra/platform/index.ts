import * as pulumi from '@pulumi/pulumi';
import { dbInstance } from './database';
import { tenantImageRepository } from './registry';
import { mediaBucket } from './mediaBucket';
import { region, projectId } from './config';
import './apis';

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
