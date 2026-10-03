import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';

export class UnisolatedTableError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(`tenant table without row-level isolation: ${tables.join(', ')}`);
    this.name = 'UnisolatedTableError';
  }
}

/**
 * Refuses a schema in which a table carrying a `tenant_id` column has no row
 * security or no `tenant_isolation` policy: a tenant table cannot be added
 * with the filter forgotten. Takes the exports of a schema module.
 */
export function assertTenantTablesIsolated(schemaExports: Record<string, unknown>): void {
  const open: string[] = [];
  for (const value of Object.values(schemaExports)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    if (!config.columns.some((column) => column.name === 'tenant_id')) continue;
    const isolated =
      config.enableRLS && config.policies.some((policy) => policy.name === 'tenant_isolation');
    if (!isolated) open.push(config.name);
  }
  if (open.length > 0) throw new UnisolatedTableError(open);
}
