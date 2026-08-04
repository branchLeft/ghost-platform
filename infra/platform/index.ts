import { dbInstance } from './database';
import { tenantImageRepository } from './registry';
import { mediaBucket } from './mediaBucket';
import './apis';

// Everything a future tenant-provisioning story needs to point at, without
// this stack knowing anything about any tenant. No hostname, tenant name,
// logical database, DB user, or credential appears anywhere in this program
// -- see the per-file comments for why each of those is deliberately absent.

export const dbInstanceConnectionName = dbInstance.connectionName;
export const dbInstanceSelfLink = dbInstance.selfLink;

export const tenantImageRepositoryUrl = tenantImageRepository.name;

export const mediaBucketUrl = mediaBucket.url;
export const mediaBucketSelfLink = mediaBucket.selfLink;
