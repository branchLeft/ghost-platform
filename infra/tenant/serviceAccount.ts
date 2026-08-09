import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { serviceAccountId } from './naming';

export { validateTenantName } from './naming';

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
      accountId: serviceAccountId(tenantName),
      displayName: `Ghost tenant "${tenantName}" - Cloud Run runtime identity`,
    },
    { parent }
  );
}
