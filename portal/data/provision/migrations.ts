import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { ClientBase } from 'pg';
import { assertTenantTablesIsolated } from '../src/isolation.js';
import * as shippedSchema from '../src/schema.js';

// The command's own migration step. drizzle's `migrate()` creates its schema
// and table outside any transaction and then sends a literal BEGIN and COMMIT
// on the client, which would commit the command's transaction part-way. This
// replays drizzle's loop instead, statement for statement and row for row, on
// the command's own client inside the command's transaction.

export interface Migration {
  tag: string;
  hash: string;
  folderMillis: number;
  statements: readonly string[];
}

function findMigrations(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('the migrations folder was not found next to the package');
}

/** The shipped migrations, in journal order, with drizzle's own hashes. */
export function readMigrations(folder: string = findMigrations()): Migration[] {
  const files = readMigrationFiles({ migrationsFolder: folder });
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  return files.map((file, index) => ({
    tag: journal.entries[index]?.tag ?? `#${index}`,
    hash: file.hash,
    folderMillis: file.folderMillis,
    statements: file.sql,
  }));
}

/** drizzle's schema and table, exactly as its migrator creates them. */
export const MIGRATIONS_SCHEMA_SQL = 'CREATE SCHEMA IF NOT EXISTS "drizzle"';
export const MIGRATIONS_TABLE_SQL = `
			CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at bigint
			)
		`;

/** The rows drizzle has recorded, oldest first; empty when its table is absent. */
export async function appliedMigrations(
  client: ClientBase
): Promise<{ hash: string; createdAt: string }[]> {
  const exists = await client.query(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present"
  );
  if (!(exists.rows[0] as { present: boolean }).present) return [];
  const rows = await client.query(
    'SELECT hash, created_at::text AS "createdAt" FROM drizzle.__drizzle_migrations ORDER BY id'
  );
  return rows.rows as { hash: string; createdAt: string }[];
}

/**
 * Applies `pending` on `client`, which must already be inside the caller's
 * transaction. Calls `afterEach` once each migration's statements and history
 * row are in, so the caller grants what it made in the same transaction.
 */
export async function replayMigrations(
  client: ClientBase,
  pending: readonly Migration[],
  afterEach: (migration: Migration) => Promise<void> = () => Promise.resolve()
): Promise<void> {
  assertTenantTablesIsolated(shippedSchema);
  if (pending.length === 0) return;
  await client.query(MIGRATIONS_SCHEMA_SQL);
  await client.query(MIGRATIONS_TABLE_SQL);
  for (const migration of pending) {
    for (const statement of migration.statements) await client.query(statement);
    await client.query(
      'insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values($1, $2)',
      [migration.hash, migration.folderMillis]
    );
    await afterEach(migration);
  }
}
