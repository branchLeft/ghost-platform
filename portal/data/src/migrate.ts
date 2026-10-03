import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { connect } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url));

/** Applies the ORM's migrations as the schema's owner, never as a portal role. */
export async function migrateSchema(
  pool: Pool,
  options: { migrationsFolder?: string; migrationsTable?: string } = {}
): Promise<void> {
  await migrate(connect(pool), {
    migrationsFolder: options.migrationsFolder ?? MIGRATIONS_DIR,
    ...(options.migrationsTable === undefined ? {} : { migrationsTable: options.migrationsTable }),
  });
}
