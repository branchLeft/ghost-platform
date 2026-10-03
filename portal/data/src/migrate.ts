import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Connectable } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export class UnisolatedTableError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(`tenant table without row-level isolation: ${tables.join(', ')}`);
    this.name = 'UnisolatedTableError';
  }
}

/**
 * Applies every migration not yet recorded, in file order, each in its own
 * transaction, then refuses a schema in which any table carrying a
 * `tenant_id` column lacks row-level security or its tenant policy. Runs as
 * the schema's owner, never as either portal role.
 */
export async function migrate(pool: Connectable, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS portal');
    await client.query(
      'CREATE TABLE IF NOT EXISTS portal.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM portal.schema_migrations')).rows.map(
        (row) => row.name
      )
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(`${dir}/${file}`, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO portal.schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(file);
    }
    await assertTenantTablesIsolated(client);
  } finally {
    client.release();
  }
  return applied;
}

/** Lists the portal tables with a tenant_id column that are not isolated. */
export async function assertTenantTablesIsolated(client: {
  query<R extends object>(sql: string): Promise<{ rows: R[] }>;
}): Promise<void> {
  const { rows } = await client.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'portal' AND c.relkind = 'r'
      AND NOT (
        c.relrowsecurity
        AND EXISTS (
          SELECT 1 FROM pg_policy p
          WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'
        )
      )
    ORDER BY c.relname`);
  if (rows.length > 0) {
    throw new UnisolatedTableError(rows.map((row) => row.table_name));
  }
}
