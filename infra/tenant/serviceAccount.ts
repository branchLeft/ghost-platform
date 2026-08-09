import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

// GCP service account IDs must be 6-30 characters: lowercase letters,
// digits, hyphens. `ghost-tenant-` is 13 characters, leaving 17 for the
// tenant name.
const ACCOUNT_ID_PREFIX = 'ghost-tenant-';
const MAX_TENANT_NAME_LENGTH = 30 - ACCOUNT_ID_PREFIX.length;
const TENANT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Validates `tenantName` against both GCP's service-account-ID constraints
 * and MySQL identifier safety (this same string is reused, with hyphens
 * folded to underscores, for the logical database name and DB username in
 * `database.ts`) -- checked once, here, rather than duplicated per call
 * site that derives a resource name from it.
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
        `"${ACCOUNT_ID_PREFIX}" prefix this component adds.`
    );
  }
}

/**
 * The per-tenant GCP service account -- the first real implementation of
 * OPEN-QUESTIONS.md #3's decision (single shared GCP project, tenants
 * isolated via per-tenant service accounts and IAM/Secret Manager
 * namespacing, not per-tenant projects). Every other resource in this
 * component either runs as this identity (the Cloud Run service) or grants
 * a narrow, resource-scoped permission to it (the DB connection, the
 * tenant's own storage prefix, the tenant's own secrets) -- nothing grants
 * this account a project-wide role. See `database.ts` and `storage.ts` for
 * why each individual grant is scoped the way it is.
 */
export function createServiceAccount(
  parent: pulumi.Resource,
  tenantName: string
): gcp.serviceaccount.Account {
  return new gcp.serviceaccount.Account(
    `${tenantName}-sa`,
    {
      accountId: `${ACCOUNT_ID_PREFIX}${tenantName}`,
      displayName: `Ghost tenant "${tenantName}" - Cloud Run runtime identity`,
    },
    { parent }
  );
}
