import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { connect } from './db.js';
import { assertTenantTablesIsolated } from './isolation.js';
import * as shippedSchema from './schema.js';

/** The package's `drizzle/` folder, found from this file whether it runs from `src/` or `dist/src/`. */
function findMigrations(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('the migrations folder was not found next to the package');
}

const MIGRATIONS_DIR = findMigrations();

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
