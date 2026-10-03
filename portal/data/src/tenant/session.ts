import type { Pool } from 'pg';
import { bind, connect, enterRole, type PortalDb, type Tx } from '../db.js';
import { tenantRegister } from '../schema.js';
import { parseTenantId } from '../tenantId.js';
import { bindTenant, type TenantScope } from './scope.js';

export interface TenantRegistration {
  tenantId: string;
  zitadelOrgId: string;
}

/**
 * The tenant-facing handle on storage. Every statement it runs is issued as
 * the `portal_tenant` role with the scope's tenant bound in the transaction;
 * row-level security on every tenant table does the filtering, and an
 * unbound statement is refused by the database.
 */
export class TenantDb {
  private readonly db: PortalDb;

  constructor(pool: Pool) {
    this.db = connect(pool);
  }

  run<T>(scope: TenantScope, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await enterRole(tx, 'portal_tenant');
      await bind(tx, 'portal.tenant_id', scope.tenantId);
      return work(tx);
    });
  }

  /** The bound tenant's own register row. */
  async ownRegistration(scope: TenantScope): Promise<TenantRegistration | null> {
    const rows = await this.run(scope, (tx) => tx.select().from(tenantRegister));
    const row = rows[0];
    return row ? { tenantId: row.tenantId, zitadelOrgId: row.zitadelOrgId } : null;
  }

  /**
   * Turns the signed-in session's Zitadel organisation into a bound tenant.
   * This is the only tenant-facing statement that runs before a tenant is
   * bound: it binds the organisation instead, and the database lets that
   * binding read the one register row for that organisation.
   */
  async scopeForOrganisation(zitadelOrgId: string): Promise<TenantScope | null> {
    const rows = await this.db.transaction(async (tx) => {
      await enterRole(tx, 'portal_tenant');
      await bind(tx, 'portal.organisation_id', zitadelOrgId);
      return tx.select({ tenantId: tenantRegister.tenantId }).from(tenantRegister);
    });
    const row = rows[0];
    return row ? bindTenant(parseTenantId(row.tenantId)) : null;
  }
}
