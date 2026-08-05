import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { secretWithValue } from './secrets';

interface StorageResult {
  writeBinding: gcp.storage.BucketIAMMember;
  accessKeyIdSecret: gcp.secretmanager.Secret;
  secretAccessKeySecret: gcp.secretmanager.Secret;
  bucketName: pulumi.Output<string>;
  /** Trailing-slash-free prefix, e.g. `blog` -- used both to build the IAM
   * condition's object-name prefix (with a trailing slash appended) and as
   * the `storage__S3Storage__tenantPrefix` env var value. */
  tenantPrefix: string;
}

/**
 * Storage write-path isolation for this tenant, plus the finding that
 * motivates the specific mechanism chosen -- see the long comment block
 * below for what is and is not actually enforced.
 *
 * Provisions nothing on the bucket itself -- `mediaBucketUrl` is imported
 * from `infra/platform`, never re-declared. The platform bucket's public
 * *read* grant (`roles/storage.legacyObjectReader` to `allUsers`,
 * `mediaBucket.ts`) is untouched by anything here; this function only ever
 * grants write-side access, and only to this one tenant's own service
 * account.
 *
 * ---
 *
 * **Storage write-isolation finding (verified against GCP docs, and
 * corrected once already in review -- see the note at the bottom):**
 *
 * The story brief's framing is correct: a GCS HMAC key is a credential
 * *for* a service account (confirmed against `@pulumi/gcp`'s own
 * `gcp.storage.HmacKey` type -- its only identity-shaped field is
 * `serviceAccountEmail`), not an independently-scoped credential. An HMAC
 * key carries exactly the IAM permissions its underlying service account
 * has been granted -- nothing more, nothing less. So the real question is
 * whether *IAM* can scope a service account's *write* access to one prefix
 * of a shared bucket. HMAC keys can only be used against the XML API, never
 * the JSON API (confirmed against Google's HMAC keys documentation).
 *
 * **Mechanism: IAM Conditions on `resource.name`, matching
 * `09-backup-restore-and-media-storage.md`'s decided design** ("IAM
 * conditions scoped to each tenant's prefix provide the per-tenant
 * isolation boundary") -- not GCS Managed Folders, which an earlier version
 * of this file used. Managed Folders were switched away from in review: the
 * citation used to justify API-agnostic enforcement for them (Google's
 * generic Cloud Storage IAM overview, "users granted IAM permissions can
 * still use the XML API...") describes ordinary bucket/object role
 * bindings, not Managed Folders specifically -- a distinct, newer GCS
 * resource type whose own documentation (fetched directly for this
 * correction: the Managed Folders overview, the managed-folder IAM
 * management page, and the interoperability/XML-API pages) never states,
 * in either direction, whether a Managed Folder's IAM policy is enforced
 * for XML API requests. That gap matters specifically because XML API is
 * the *only* API HMAC keys can use -- presenting an extrapolated citation
 * as confirmation for exactly the property this story most needed proven
 * was the error, caught on review, not accepted here.
 *
 * IAM Conditions don't have that gap: a condition is a predicate on an
 * ordinary IAM role binding (the same `Policy`/`Binding` structure used for
 * every other grant in this codebase, e.g. `mediaBucket.ts`'s public-read
 * grant), not a separate resource type or enforcement path -- so the
 * generic IAM-overview citation actually applies to it, unlike to Managed
 * Folders. Condition expression format confirmed against two independent
 * Google sources (the Cloud Storage IAM-conditions guidance and the IAM
 * conditions attribute reference): `resource.name` for a Cloud Storage
 * object is `projects/_/buckets/BUCKET_NAME/objects/OBJECT_NAME` --
 * **`_` is a literal placeholder, not this project's real ID** (verified
 * from two sources independently after Managed Folders' single-citation
 * mistake, specifically to not repeat it) -- so
 * `resource.name.startsWith("projects/_/buckets/<bucket>/objects/<prefix>/")`
 * is the documented pattern for scoping a role binding to one prefix.
 *
 * **What this actually enforces vs. what it doesn't -- including what
 * remains genuinely unverified, stated plainly rather than glossed over.**
 * The service account created for this tenant is granted
 * `roles/storage.objectCreator` (create only) and `roles/storage.legacyObjectReader`
 * (get only, no list -- the same role `mediaBucket.ts` uses for the
 * platform's public-read grant, for the same reason) via two separate
 * conditional bindings, plus `storage.objects.delete` is **not** granted --
 * see the note below on why that's a real, disclosed functional gap rather
 * than a silent one. Both conditions are scoped to this tenant's own
 * prefix, never bucket-level and never `allUsers`.
 * - `storage.objects.list` is **deliberately not granted at all**, to this
 *   tenant's SA, in any scope. Ghost's `S3Storage.ts` adapter (read
 *   directly for this story) never calls `ListObjectsCommand`, so this
 *   costs nothing functionally. It's also the right call given a real,
 *   documented ambiguity: Google's own IAM-conditions-for-Cloud-Storage
 *   guidance says list requests need a *different*, special API attribute
 *   (`storage.googleapis.com/objectListPrefix`) to be scoped correctly, and
 *   separately warns that Cloud Storage API attributes "are supported only
 *   in Credential Access Boundaries; if you use [them] in a conditional
 *   role binding, Cloud Storage methods will work incorrectly and fail
 *   unexpectedly." A plain `resource.name.startsWith(...)` condition on
 *   `storage.objects.list` is therefore not confirmed to scope list at all
 *   (list's own authorized resource is arguably the bucket, not an object
 *   name) -- rather than ship an unverified guess in either direction
 *   (silently over-broad, or silently non-functional), this component just
 *   doesn't grant it.
 * - **Not granting `storage.objects.delete` is a real functional gap,
 *   disclosed rather than hidden.** Ghost's adapter does call
 *   `DeleteObjectCommand` (its own `delete()` method). There is no
 *   predefined GCS role bundling exactly create+get+delete without also
 *   bundling `list` (`roles/storage.objectUser` is the closest, but
 *   reintroduces the list ambiguity above across the *entire* grant,
 *   including the permissions that don't have that ambiguity). A precise
 *   fix is a custom IAM role with exactly those three permissions --
 *   deliberately not added here, because a custom role is a
 *   platform-level, created-once resource (the same permission set for
 *   every tenant, only the condition differing), and defining it from
 *   *this* per-tenant component would mean every independent tenant stack
 *   fights to own the same shared role resource -- the identical shape of
 *   problem this codebase already declined to solve from a per-tenant
 *   component for a different reason (`database.ts`'s
 *   `MAX_USER_CONNECTIONS` note). The right fix is a
 *   `gcp.projects.IAMCustomRole` added to `infra/platform/` in its own
 *   change, out of scope for this story to make unilaterally. Until then:
 *   deleting/replacing an existing upload from Ghost's admin will fail for
 *   any tenant using this component, loudly (a 403 from GCS), not
 *   silently.
 * - **Residual, unverified-against-a-live-bucket risk, named rather than
 *   assumed away**, because `pulumi up` is never run in this story: (1)
 *   whether `resource.name.startsWith(...)` conditions require the prefix
 *   to already contain at least one object before a *new* create request
 *   under that prefix is authorized (one third-party writeup claims yes for
 *   a similar setup; GCS's own docs don't say either way for the plain
 *   condition case, as opposed to Managed Folders, where pre-existence is
 *   explicitly documented as required) -- if true, the very first upload
 *   for a brand-new tenant could 403 until worked around. (2) Whether GCS
 *   evaluates `resource.name` conditions identically for XML-API multipart
 *   upload commands (`CreateMultipartUploadCommand`/`UploadPartCommand`/
 *   `CompleteMultipartUploadCommand`) as it does for a single `PutObject`
 *   call -- the generic IAM-is-API-agnostic citation supports this but
 *   multipart's multi-request shape was not independently confirmed.
 *   Either failure mode here is fail-closed (uploads 403 loudly) rather
 *   than fail-open (cross-tenant write), since `uniformBucketLevelAccess`
 *   is on and this SA has no bucket-level grant to fall back to -- but
 *   "likely fail-closed" is a severity note, not a substitute for actually
 *   exercising this against a real bucket before a real tenant depends on
 *   it, which is exactly what the smoke-test stack in this PR cannot do
 *   (preview only, nothing applied).
 */
export function createTenantStorage(
  parent: pulumi.Resource,
  tenantName: string,
  mediaBucketUrl: pulumi.Input<string>,
  serviceAccount: gcp.serviceaccount.Account
): StorageResult {
  const bucketName = pulumi.output(mediaBucketUrl).apply((url) => {
    // Documented, stable format: `gs://<bucket-name>` (confirmed against
    // @pulumi/gcp's own field doc for `gcp.storage.Bucket.url`). Recovering
    // the bare name this way avoids infra/platform needing to export it
    // separately -- out of scope for this story to add.
    const prefix = 'gs://';
    if (!url.startsWith(prefix)) {
      throw new Error(`GhostTenant: mediaBucketUrl "${url}" doesn't start with "${prefix}".`);
    }
    return url.slice(prefix.length);
  });

  const tenantPrefix = tenantName;

  // Trailing slash is load-bearing: without it, `resource.name.startsWith(...)`
  // would also match a *different* tenant whose prefix happens to share this
  // one as a literal string prefix (e.g. tenant "blog" would otherwise also
  // match objects under "blog-archive/") -- Ghost's own `S3Storage.ts`
  // (`buildKey`) always inserts a `/` immediately after `tenantPrefix` when
  // constructing a key, so this matches the real object-key shape, not an
  // assumption about it.
  // `_` is a literal placeholder GCP's own attribute-reference docs use for
  // the project segment of a Cloud Storage resource name in IAM Conditions
  // -- not this project's real ID. Verified against two independent Google
  // sources; see the long comment above for why that mattered here
  // specifically.
  const conditionResourcePrefix = pulumi.interpolate`projects/_/buckets/${bucketName}/objects/${tenantPrefix}/`;

  function conditionedBinding(name: string, role: string) {
    return new gcp.storage.BucketIAMMember(
      name,
      {
        bucket: bucketName,
        role,
        member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
        condition: {
          title: `${tenantName}-own-prefix-only`,
          description: `Restricts ${role} to this tenant's own object-name prefix in the shared media bucket.`,
          expression: pulumi.interpolate`resource.name.startsWith("${conditionResourcePrefix}")`,
        },
      },
      { parent }
    );
  }

  // create + get, each condition-scoped to this tenant's own prefix. See the
  // long comment above for why `delete` and `list` are deliberately not
  // granted here.
  const writeBinding = conditionedBinding(`${tenantName}-media-create`, 'roles/storage.objectCreator');
  conditionedBinding(`${tenantName}-media-read`, 'roles/storage.legacyObjectReader');

  const hmacKey = new gcp.storage.HmacKey(
    `${tenantName}-media-hmac`,
    {
      serviceAccountEmail: serviceAccount.email,
    },
    { parent }
  );

  const accessKeyIdSecret = secretWithValue(
    parent,
    `${tenantName}-hmac-access-key-id`,
    `ghost-tenant-${tenantName}-hmac-access-key-id`,
    hmacKey.accessId,
    serviceAccount.email
  ).secret;

  const secretAccessKeySecret = secretWithValue(
    parent,
    `${tenantName}-hmac-secret-access-key`,
    `ghost-tenant-${tenantName}-hmac-secret-access-key`,
    hmacKey.secret,
    serviceAccount.email
  ).secret;

  return { writeBinding, accessKeyIdSecret, secretAccessKeySecret, bucketName, tenantPrefix };
}
