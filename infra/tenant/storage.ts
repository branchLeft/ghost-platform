import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { secretWithValue } from './secrets';

interface StorageResult {
  managedFolder: gcp.storage.ManagedFolder;
  accessKeyIdSecret: gcp.secretmanager.Secret;
  secretAccessKeySecret: gcp.secretmanager.Secret;
  bucketName: pulumi.Output<string>;
  /** Trailing-slash-free prefix, e.g. `blog` -- used both as the managed
   * folder name (with a trailing slash appended) and as the
   * `storage__S3Storage__tenantPrefix` env var value. */
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
 * **Storage write-isolation finding (verified against GCP docs/source, not
 * assumed):**
 *
 * The story brief's framing is correct: a GCS HMAC key is a credential
 * *for* a service account (confirmed against `@pulumi/gcp`'s own
 * `gcp.storage.HmacKey` type -- its only identity-shaped field is
 * `serviceAccountEmail`), not an independently-scoped credential. An HMAC
 * key carries exactly the IAM permissions its underlying service account
 * has been granted -- nothing more, nothing less. So the real question is
 * whether *IAM* can scope a service account's *write* access to one prefix
 * of a shared bucket, and whether that scoping is actually enforced when
 * the access happens over the S3-compatible XML API (which is how Ghost's
 * `S3Storage` adapter and every HMAC-authenticated request work -- HMAC
 * keys can only be used against the XML API, never the JSON API, confirmed
 * against Google's HMAC keys documentation).
 *
 * **Yes, via GCS Managed Folders, and yes, IAM is API-agnostic.** Two
 * things had to each be true, verified separately:
 *
 * 1. Managed folders (`gcp.storage.ManagedFolder`, a real bucket-scoped
 *    resource requiring `uniformBucketLevelAccess` -- already set on the
 *    platform's media bucket, confirmed by reading `mediaBucket.ts`) let an
 *    IAM policy be scoped to only the objects under a given prefix.
 *    Confirmed against Google's Managed Folders documentation and IAM
 *    permissions reference: `storage.objects.create` (needed for
 *    `PutObjectCommand`/multipart uploads), `storage.objects.get` (needed
 *    for `HeadObjectCommand`/`GetObjectCommand`) and `storage.objects.list`
 *    can all be granted at the managed-folder level, and that grant applies
 *    to objects using the folder's path as a name prefix -- including
 *    objects that don't exist yet at upload time. One documented caveat
 *    that matters operationally: **the managed folder must already exist**
 *    before a create request against that prefix will be authorized by its
 *    policy -- this component creates the `ManagedFolder` resource itself,
 *    ahead of granting IAM on it, so that ordering is handled here rather
 *    than left to whoever instantiates this component.
 * 2. IAM enforcement is not JSON-API-only. Google's Cloud Storage IAM
 *    overview states directly: "Although IAM permissions cannot be set
 *    through the XML API, users granted IAM permissions can still use the
 *    XML API, as well as any other tool for accessing Cloud Storage." That
 *    settles the specific risk this story flagged -- an HMAC key used over
 *    the XML API is authorized by the same IAM policy as any other access
 *    path for the same service account, not some broader or bypassed check.
 *
 * **What this actually enforces vs. what it doesn't.** The service account
 * created for this tenant is granted `roles/storage.objectUser`
 * (create/get/list/delete -- deliberately not `objectAdmin`, which also
 * bundles `setIamPolicy`/`update`, permissions Ghost's own adapter never
 * calls; see the `S3Storage.ts` source read for this story, which only ever
 * issues Put/Get/Head/Delete/multipart-upload commands) scoped **only** to
 * this tenant's own managed folder -- never at the bucket level. That
 * means:
 * - This tenant's HMAC key cannot write, overwrite, or delete any object
 *   outside its own prefix -- it has no bucket-level grant to fall back to.
 * - This tenant's HMAC key *can* read and list within its own prefix
 *   (`objectUser` bundles `get`/`list`, and Ghost's adapter uses `get` for
 *   `exists()`/`read()`) -- not write-only in the strictest sense, but
 *   confined to its own prefix either way, so this doesn't reopen the
 *   cross-tenant read/enumeration risk `mediaBucket.ts`'s public-read
 *   finding was about (that finding was specifically about `allUsers`
 *   listing *every* tenant's prefix at the bucket level; this grant is
 *   neither `allUsers` nor bucket-level).
 * - This is a genuinely narrower, resource-scoped grant, not a
 *   convention or a naming pattern that merely looks scoped -- confirmed
 *   against `gcp.storage.ManagedFolderIamMember`'s own binding target
 *   (`bucket` + `managedFolder`, not `bucket` alone).
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

  const managedFolder = new gcp.storage.ManagedFolder(
    `${tenantName}-media-folder`,
    {
      bucket: bucketName,
      // Managed folder names must end with a trailing slash.
      name: `${tenantPrefix}/`,
    },
    { parent }
  );

  new gcp.storage.ManagedFolderIamMember(
    `${tenantName}-media-write`,
    {
      bucket: bucketName,
      managedFolder: managedFolder.name,
      // create + get + list + delete, deliberately not objectAdmin -- see
      // the write-isolation finding above for why this specific role.
      role: 'roles/storage.objectUser',
      member: pulumi.interpolate`serviceAccount:${serviceAccount.email}`,
    },
    { parent: managedFolder }
  );

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

  return { managedFolder, accessKeyIdSecret, secretAccessKeySecret, bucketName, tenantPrefix };
}
