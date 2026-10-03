import { inTransaction, type Connectable } from '../db.js';
import { parseTenantId } from '../tenantId.js';
import type { TenantRegistration } from '../tenant/register.js';

/**
 * The owner console's cross-tenant reads and the register's writes. A
 * separate entry point on purpose: the tenant-facing code never imports it,
 * and the pool it takes is connected as a login that is a member of
 * `portal_owner` alone.
 */
export class OwnerDb {
  constructor(private readonly pool: Connectable) {}

  async registerTenant(registration: TenantRegistration): Promise<void> {
    const tenantId = parseTenantId(registration.tenantId);
    await inTransaction(this.pool, setOwnerRole, async (client) => {
      await client.query(
        'INSERT INTO portal.tenant_register (tenant_id, zitadel_org_id) VALUES ($1, $2)',
        [tenantId, registration.zitadelOrgId]
      );
    });
  }

  async listTenants(): Promise<TenantRegistration[]> {
    return inTransaction(this.pool, setOwnerRole, async (client) => {
      const { rows } = await client.query<{ tenant_id: string; zitadel_org_id: string }>(
        'SELECT tenant_id, zitadel_org_id FROM portal.tenant_register ORDER BY created_at, tenant_id'
      );
      return rows.map((row) => ({
        tenantId: row.tenant_id,
        zitadelOrgId: row.zitadel_org_id,
      }));
    });
  }
}

async function setOwnerRole(client: { query(sql: string): Promise<unknown> }): Promise<void> {
  await client.query('SET LOCAL ROLE portal_owner');
}
