import * as gcp from '@pulumi/gcp';
import { mediaBucketName, region } from './config';
import { enabledApis } from './apis';

/**
 * The one shared media bucket for every tenant (doc 09: one bucket,
 * tenant-prefixed paths -- explicitly *not* one bucket per tenant, to avoid
 * GCS bucket-count/IAM sprawl at "hundreds of tenants" scale). Holds no
 * tenant-prefix structure itself -- `storage__S3Storage__tenantPrefix` is
 * per-tenant deploy config (this repo's README), supplied by the tenant
 * component (next story), not a resource this shared stack creates.
 *
 * Regional (not multi-region/dual-region) in `europe-west1` -- the smallest
 * workable storage class for two low-traffic tenants, and keeps data
 * resident in the same region as the database per doc 02's EU/UK residency
 * requirement.
 *
 * **Deliberately public-read, not a misconfiguration.** This repo's README
 * documents `storage__S3Storage__cdnUrl` as either a CDN in front of the
 * bucket, or `https://storage.googleapis.com/<bucket>` directly -- and doc
 * 07 places a CDN (Cloud CDN, on the shared edge's backend service) at
 * Tier 3-4, not Tier 1-2 where both current tenants sit. Until a tenant
 * needs a CDN, readers load published article media directly from this
 * bucket, so it must serve object reads to `allUsers` or every image on
 * every tenant site 403s -- a misconfiguration in the *opposite* direction
 * (private-by-default) would be the silent-looking failure here, since
 * uploads would still succeed and only break on the reader's next page
 * load. `uniformBucketLevelAccess` means this can only be a bucket-level
 * grant, not a per-object ACL -- scoping read access to a tenant's own
 * prefix isn't possible with IAM alone, but isn't a gap this decision
 * introduces: every tenant's *published* media is meant to be publicly
 * readable regardless (it's served on their public site), so bucket-wide
 * public read matches the actual requirement rather than falling short of
 * a tighter one. Per-tenant isolation for *writes* (the HMAC key that can
 * upload into a tenant's own prefix) is a tenant-provisioning concern for
 * the next story, not a read-access concern for this one.
 */
export const mediaBucket = new gcp.storage.Bucket(
  'ghost-platform-media',
  {
    name: mediaBucketName,
    location: region,
    storageClass: 'STANDARD',
    uniformBucketLevelAccess: true,

    // Doc 09's media backup decision: object versioning plus a 30-day
    // noncurrent-version lifecycle rule, so an overwritten/deleted image is
    // recoverable without storage cost growing unbounded.
    versioning: {
      enabled: true,
    },
    lifecycleRules: [
      {
        condition: {
          daysSinceNoncurrentTime: 30,
        },
        action: {
          type: 'Delete',
        },
      },
    ],
  },
  { dependsOn: enabledApis }
);

export const mediaBucketPublicRead = new gcp.storage.BucketIAMMember(
  'ghost-platform-media-public-read',
  {
    bucket: mediaBucket.name,
    role: 'roles/storage.objectViewer',
    member: 'allUsers',
  }
);
