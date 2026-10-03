import { inTransaction, type Connectable, type Queryable } from '../db.js';
import type { TenantScope } from './scope.js';

/**
 * The tenant-facing handle on storage. Every statement it runs is issued as
 * the `portal_tenant` role with the scope's tenant bound in the transaction;
 * row-level security on every tenant table does the filtering, and an
 * unbound statement is refused by the database.
 */
export class TenantDb {
  constructor(private readonly pool: Connectable) {}

  run<T>(scope: TenantScope, work: (client: Queryable) => Promise<T>): Promise<T> {
    return inTransaction(
      this.pool,
      async (client) => {
        await client.query('SET LOCAL ROLE portal_tenant');
        await client.query("SELECT set_config('portal.tenant_id', $1, true)", [scope.tenantId]);
      },
      work
    );
  }
}
