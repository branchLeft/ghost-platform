import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { connect } from './db.js';
import { assertTenantTablesIsolated } from './isolation.js';
import * as shippedSchema from './schema.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));

/**
 * Applies the ORM's migrations as the schema's owner, never as a portal role.
 * Refuses first when the schema holds a tenant table without its isolation, so
 * an unisolated table cannot be applied to a database at all.
 */
export async function migrateSchema(
  pool: Pool,
  options: {
    migrationsFolder?: string;
    migrationsTable?: string;
    schemaExports?: Record<string, unknown>;
  } = {}
): Promise<void> {
  assertTenantTablesIsolated(options.schemaExports ?? shippedSchema);
  await migrate(connect(pool), {
    migrationsFolder: options.migrationsFolder ?? MIGRATIONS_DIR,
    ...(options.migrationsTable === undefined ? {} : { migrationsTable: options.migrationsTable }),
  });
}
