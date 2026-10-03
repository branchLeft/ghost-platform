import { inTransaction, type Connectable } from '../db.js';
import { parseTenantId } from '../tenantId.js';
import { bindTenant, type TenantScope } from './scope.js';
import type { TenantDb } from './session.js';

export interface TenantRegistration {
  tenantId: string;
  zitadelOrgId: string;
}

/** The bound tenant's own register row. */
export async function ownRegistration(
  db: TenantDb,
  scope: TenantScope
): Promise<TenantRegistration | null> {
  return db.run(scope, async (client) => {
    const { rows } = await client.query<{ tenant_id: string; zitadel_org_id: string }>(
      'SELECT tenant_id, zitadel_org_id FROM portal.tenant_register'
    );
    const row = rows[0];
    return row ? { tenantId: row.tenant_id, zitadelOrgId: row.zitadel_org_id } : null;
  });
}

/**
 * Turns the signed-in session's Zitadel organisation into a bound tenant.
 * This is the only tenant-facing statement that runs before a tenant is
 * bound, and it can answer only for the one organisation it is asked about.
 */
export async function bindTenantFromOrganisation(
  pool: Connectable,
  zitadelOrgId: string
): Promise<TenantScope | null> {
  const found = await inTransaction(
    pool,
    async (client) => {
      await client.query('SET LOCAL ROLE portal_tenant');
    },
    async (client) => {
      const { rows } = await client.query<{ tenant_id: string | null }>(
        'SELECT portal.tenant_for_org($1) AS tenant_id',
        [zitadelOrgId]
      );
      return rows[0]?.tenant_id ?? null;
    }
  );
  return found === null ? null : bindTenant(parseTenantId(found));
}
