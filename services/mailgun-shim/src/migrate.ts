import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Where drizzle-kit writes the migrations: `../drizzle` from both `src/` and `dist/`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

// Positions in drizzle/meta/_journal.json. See store.md#schema-and-migrations.
export const BASELINE = 0;
export const DRAIN_HANDOVER = 1;
export const SENDER_DOMAIN = 2;

/** drizzle's own migration ledger, so drizzle-kit and this runner read one history. */
export const migrationsLedger = sqliteTable('__drizzle_migrations', {
  id: integer('id'),
  hash: text('hash').notNull(),
  createdAt: integer('created_at'),
});

const sqliteMaster = sqliteTable('sqlite_master', {
  type: text('type').notNull(),
  name: text('name').notNull(),
});

type Tx = Parameters<Parameters<BetterSQLite3Database['transaction']>[0]>[0];

const PRE_DRAIN_QUEUE = [
  'attempts',
  'batch_id',
  'last_error',
  'next_attempt_at',
  'recipient',
  'status',
];
const DRAIN_QUEUE = [
  'available_at',
  'batch_id',
  'drain_count',
  'held_until',
  'id',
  'last_error',
  'recipient',
  'status',
];
const TENANTS = ['api_key_hash', 'api_key_salt', 'domain'];
const TENANTS_WITH_SENDER = [...TENANTS, 'sender_domain'].sort();

/**
 * Brings the database to the newest migration in one IMMEDIATE transaction,
 * so a second process opening the same file waits, then finds nothing to do.
 * Throws, changing nothing, on a schema this history cannot account for.
 * See store.md#schema-and-migrations.
 */
export function migrateStore(
  client: BetterSqlite3.Database,
  migrationsFolder: string = MIGRATIONS_FOLDER
): void {
  const migrations = readMigrationFiles({ migrationsFolder });
  drizzle(client).transaction((tx) => applyMigrations(tx, client, migrations), {
    behavior: 'immediate',
  });
}

/** The body of `migrateStore`'s transaction, for a caller that already holds one. */
export function applyMigrations(
  tx: Tx,
  client: BetterSqlite3.Database,
  migrations: MigrationMeta[]
): void {
  // drizzle's migrator creates its ledger with exactly this statement.
  tx.run(
    sql`CREATE TABLE IF NOT EXISTS ${migrationsLedger} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
  );

  let appliedThrough = latestApplied(tx);
  if (appliedThrough === undefined && hasObject(tx, 'table', 'tenants')) {
    appliedThrough = baselineLegacyDatabase(tx, client, migrations);
  }

  migrations.forEach((migration, index) => {
    if (appliedThrough !== undefined && migration.folderMillis <= appliedThrough) {
      return;
    }
    for (const statement of migration.sql) {
      runMigrationStatement(tx, index, statement);
    }
    recordApplied(tx, migration);
  });
}

// drizzle reports a failed statement as "Failed to run the query", keeping
// SQLite's own reason only as the cause; the reason is what an operator needs.
function runMigrationStatement(tx: Tx, index: number, statement: string): void {
  try {
    tx.run(sql.raw(statement));
  } catch (err) {
    const reason = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new Error(`Migration ${index} failed: ${message}`, { cause: err });
  }
}

function latestApplied(tx: Tx): number | undefined {
  const row = tx
    .select({ createdAt: migrationsLedger.createdAt })
    .from(migrationsLedger)
    .orderBy(desc(migrationsLedger.createdAt))
    .limit(1)
    .get();
  return row?.createdAt ?? undefined;
}

function recordApplied(tx: Tx, migration: MigrationMeta): void {
  tx.insert(migrationsLedger)
    .values({ hash: migration.hash, createdAt: migration.folderMillis })
    .run();
}

function hasObject(tx: Tx, type: 'table' | 'index', name: string): boolean {
  return (
    tx
      .select({ name: sqliteMaster.name })
      .from(sqliteMaster)
      .where(and(eq(sqliteMaster.type, type), eq(sqliteMaster.name, name)))
      .get() !== undefined
  );
}

function columnsOf(client: BetterSqlite3.Database, table: 'tenants' | 'queue_recipients'): string {
  const rows = client.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows
    .map((row) => row.name)
    .sort()
    .join(',');
}

/**
 * A database written before the ledger existed: records every migration its
 * shape already reflects, creating any baseline table it lacks, and returns
 * the newest one recorded. See store.md#databases-older-than-the-ledger.
 */
function baselineLegacyDatabase(
  tx: Tx,
  client: BetterSqlite3.Database,
  migrations: MigrationMeta[]
): number {
  const queue = columnsOf(client, 'queue_recipients');
  const tenants = columnsOf(client, 'tenants');

  let reflects: number;
  if ((queue === '' || queue === PRE_DRAIN_QUEUE.join(',')) && tenants === TENANTS.join(',')) {
    reflects = BASELINE;
    createMissingBaselineObjects(tx, migrations[BASELINE]!);
  } else if (queue === DRAIN_QUEUE.join(',') && tenants === TENANTS.join(',')) {
    reflects = DRAIN_HANDOVER;
  } else if (queue === DRAIN_QUEUE.join(',') && tenants === TENANTS_WITH_SENDER.join(',')) {
    reflects = SENDER_DOMAIN;
  } else {
    throw new Error(
      `Unrecognised schema in a database older than the migration ledger: ` +
        `queue_recipients(${queue}) tenants(${tenants})`
    );
  }

  for (const migration of migrations.slice(0, reflects + 1)) {
    recordApplied(tx, migration);
  }
  return migrations[reflects]!.folderMillis;
}

function createMissingBaselineObjects(tx: Tx, baseline: MigrationMeta): void {
  for (const statement of baseline.sql) {
    const created = /^\s*CREATE (?:UNIQUE )?(TABLE|INDEX) \W(\w+)\W/.exec(statement);
    if (!created) {
      throw new Error(
        `The baseline migration holds a statement that creates nothing: ${statement}`
      );
    }
    const [, kind, name] = created;
    if (!hasObject(tx, kind!.toLowerCase() as 'table' | 'index', name!)) {
      runMigrationStatement(tx, BASELINE, statement);
    }
  }
}
