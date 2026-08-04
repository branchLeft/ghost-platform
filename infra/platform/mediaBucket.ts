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
 * **Deliberately public-read, not a misconfiguration -- but scoped to
 * `get`, not `list`.** This repo's README documents
 * `storage__S3Storage__cdnUrl` as either a CDN in front of the bucket, or
 * `https://storage.googleapis.com/<bucket>` directly -- and doc 07 places a
 * CDN (Cloud CDN, on the shared edge's backend service) at Tier 3-4, not
 * Tier 1-2 where both current tenants sit. Until a tenant needs a CDN,
 * readers load published article media directly from this bucket by its
 * full known path (Ghost emits `<img src="https://storage.googleapis.com/
 * <bucket>/<prefix>/...">` with the path already resolved -- serving a page
 * never calls `list`), so the bucket must serve `storage.objects.get` to
 * `allUsers` or every image on every tenant site 403s. A misconfiguration
 * in the *opposite* direction (private-by-default) would be the
 * silent-looking failure here, since uploads would still succeed and only
 * break on the reader's next page load.
 *
 * **`get` is not the same grant as `list`, and only `get` is needed.**
 * An earlier version of this file granted `roles/storage.objectViewer`,
 * which bundles both `storage.objects.get` *and* `storage.objects.list`
 * (verified against Google's Cloud Storage IAM roles reference,
 * `docs.cloud.google.com/storage/docs/access-control/iam-roles` -- not
 * assumed from the role's name). Granting that to `allUsers` on a bucket
 * doc 09 structures as tenant-prefixed paths made every tenant's prefix
 * enumerable with an unauthenticated `gsutil ls -r`, with no
 * credentials and nothing logged on the tenant's side -- a complete client
 * roster, from a layer doc 03's 2026-08-03 revision ("tenant anonymity
 * forced Layer 1 to split") specifically introduced a second private repo
 * to prevent: "the tenant registry is private for everyone, not a
 * judgement call made per client." That blanket policy is defeated just as
 * completely by a listable bucket as by a public Layer 1 repo -- doc 03
 * was protecting the same fact (who branchLeft's clients are) from a
 * different leak surface. Doc 12 §1's UK-investigative-local-news threat
 * model (plausible targets for coordinated harassment because of what they
 * publish) is why that fact matters, even though doc 12 §1 itself doesn't
 * discuss this bucket.
 *
 * Fixed by granting `roles/storage.legacyObjectReader` instead, confirmed
 * against the same IAM roles reference to include `storage.objects.get`
 * and *not* `storage.objects.list` (nor any bucket- or folder-level
 * permission) -- read access to a known path, no enumeration.
 * `uniformBucketLevelAccess` still means this is a bucket-level grant, not
 * a per-object ACL, so it can't be scoped to a single tenant's prefix --
 * but that's not a gap here: every tenant's *published* media is meant to
 * be publicly readable regardless (it's served on their public site), the
 * roster-leak risk was specifically the `list` permission, not `get`.
 * Per-tenant isolation for *writes* (the HMAC key that can upload into a
 * tenant's own prefix) is a tenant-provisioning concern for the next
 * story, not a read-access concern for this one.
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
    // `get`-only, deliberately not `objectViewer` -- see the roster-leak
    // note above.
    role: 'roles/storage.legacyObjectReader',
    member: 'allUsers',
  }
);
