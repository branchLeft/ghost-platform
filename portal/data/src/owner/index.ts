import { asc } from 'drizzle-orm';
import type { Pool } from 'pg';
import { connect, enterRole, type PortalDb } from '../db.js';
import { tenantRegister } from '../schema.js';
import { parseTenantId } from '../tenantId.js';
import type { TenantRegistration } from '../tenant/session.js';

/**
 * The owner console's cross-tenant reads and the register's writes. A
 * separate entry point on purpose: the tenant-facing code never imports it,
 * and the pool it takes is connected as a login that is a member of
 * `portal_owner` alone.
 */
export class OwnerDb {
  private readonly db: PortalDb;

  constructor(pool: Pool) {
    this.db = connect(pool);
  }

  async registerTenant(registration: TenantRegistration): Promise<void> {
    const tenantId = parseTenantId(registration.tenantId);
    await this.db.transaction(async (tx) => {
      await enterRole(tx, 'portal_owner');
      await tx.insert(tenantRegister).values({ tenantId, zitadelOrgId: registration.zitadelOrgId });
    });
  }

  async listTenants(): Promise<TenantRegistration[]> {
    return this.db.transaction(async (tx) => {
      await enterRole(tx, 'portal_owner');
      const rows = await tx
        .select()
        .from(tenantRegister)
        .orderBy(asc(tenantRegister.createdAt), asc(tenantRegister.tenantId));
      return rows.map((row) => ({ tenantId: row.tenantId, zitadelOrgId: row.zitadelOrgId }));
    });
  }
}
