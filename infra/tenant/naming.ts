/**
 * Every resource name this component derives from `tenantName`, in one place.
 *
 * These are pure string functions with no Pulumi types, so they are the only
 * part of the component that can be tested without a Pulumi engine — which
 * matters most for `mediaObjectConditionResource`, whose trailing slash is a
 * cross-tenant isolation boundary rather than a formatting choice.
 */

/**
 * GCP service account IDs must be 6-30 characters: lowercase letters, digits,
 * hyphens. This prefix is 13, leaving 17 for the tenant name.
 */
export const TENANT_RESOURCE_PREFIX = 'ghost-tenant-';

export const MAX_TENANT_NAME_LENGTH = 30 - TENANT_RESOURCE_PREFIX.length;

const TENANT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** `gs://<bucket-name>`, per `gcp.storage.Bucket.url`'s own field doc. */
const BUCKET_URL_PREFIX = 'gs://';

/**
 * This component's own choice of image name within the shared tenant
 * repository. Every tenant runs the same image, so there is one name here, not
 * one per tenant.
 */
const TENANT_IMAGE_NAME = 'ghost';

const IMAGE_DIGEST_PREFIX = 'sha256:';

/**
 * Validates `tenantName` against both GCP's service-account-ID constraints and
 * MySQL identifier safety — the same string is reused, with hyphens folded to
 * underscores, for the logical database name and DB username.
 */
export function validateTenantName(tenantName: string): void {
  if (!TENANT_NAME_PATTERN.test(tenantName)) {
    throw new Error(
      `GhostTenant: tenantName "${tenantName}" must start with a lowercase letter and contain only ` +
        `lowercase letters, digits and hyphens.`
    );
  }
  if (tenantName.length > MAX_TENANT_NAME_LENGTH) {
    throw new Error(
      `GhostTenant: tenantName "${tenantName}" is ${tenantName.length} characters; must be at most ` +
        `${MAX_TENANT_NAME_LENGTH} to fit GCP's 30-character service-account-ID limit alongside the ` +
        `"${TENANT_RESOURCE_PREFIX}" prefix this component adds.`
    );
  }
}

/** The tenant's Cloud Run runtime identity. */
export function serviceAccountId(tenantName: string): string {
  return `${TENANT_RESOURCE_PREFIX}${tenantName}`;
}

/** The tenant's Cloud Run service. Shares the service account's prefix. */
export function cloudRunServiceName(tenantName: string): string {
  return `${TENANT_RESOURCE_PREFIX}${tenantName}`;
}

/** MySQL identifiers cannot carry the hyphens a tenant name may. */
export function sqlIdentifier(tenantName: string): string {
  return tenantName.replaceAll('-', '_');
}

/** The tenant's logical database and its dedicated DB user share this name. */
export function databaseAndUserName(sqlId: string): string {
  return `ghost_${sqlId}`;
}

/**
 * Recovers the bare bucket name from the platform stack's exported URL, so
 * the platform stack does not have to export it a second time.
 */
export function bucketNameFromUrl(mediaBucketUrl: string): string {
  if (!mediaBucketUrl.startsWith(BUCKET_URL_PREFIX)) {
    throw new Error(
      `GhostTenant: mediaBucketUrl "${mediaBucketUrl}" doesn't start with "${BUCKET_URL_PREFIX}".`
    );
  }
  return mediaBucketUrl.slice(BUCKET_URL_PREFIX.length);
}

/**
 * The tenant's object-name prefix in the shared media bucket.
 *
 * The trailing slash is load-bearing. The IAM condition below matches with
 * `startsWith`, so without it tenant `blog` would also match every object
 * under `blog-archive/`. Ghost's own `S3Storage.buildKey` always inserts a `/`
 * immediately after the prefix, so this matches the real object-key shape
 * rather than an assumption about it.
 */
export function mediaObjectPrefix(tenantName: string): string {
  return `${tenantName}/`;
}

/**
 * What Ghost receives as `storage__S3Storage__tenantPrefix`.
 *
 * Deliberately *without* the trailing slash that `mediaObjectPrefix` carries:
 * `S3Storage.buildKey` inserts the separator itself, so a slash here would
 * write every object under `<tenant>//`. The IAM condition would still match,
 * so this fails silently in both directions — which is why the relationship
 * between the two is asserted rather than left to the reader.
 */
export function mediaTenantPrefixEnvValue(tenantName: string): string {
  return tenantName;
}

/**
 * The container image reference to deploy.
 *
 * A digest joins with `@` and a tag with `:`. Getting this wrong is not a
 * cosmetic difference: `repo/ghost:sha256:<hex>` is rejected outright by the
 * Cloud Run API as a malformed image path, so a digest-pinned deploy fails at
 * create time rather than running the wrong revision.
 */
export function tenantImageRef(repositoryDockerPath: string, digestOrTag: string): string {
  const separator = digestOrTag.startsWith(IMAGE_DIGEST_PREFIX) ? '@' : ':';
  return `${repositoryDockerPath}/${TENANT_IMAGE_NAME}${separator}${digestOrTag}`;
}

/** Secret Manager ids for this tenant, sharing the resource prefix. */
export function tenantSecretName(tenantName: string, suffix: string): string {
  return `${TENANT_RESOURCE_PREFIX}${tenantName}-${suffix}`;
}

/**
 * The resource-name prefix the media-bucket IAM conditions match on.
 *
 * `_` is a literal placeholder GCP's attribute-reference docs use for the
 * project segment of a Cloud Storage resource name in IAM Conditions — not a
 * real project ID.
 */
export function mediaObjectConditionResource(bucketName: string, tenantName: string): string {
  return `projects/_/buckets/${bucketName}/objects/${mediaObjectPrefix(tenantName)}`;
}
