import Database from 'better-sqlite3';
import { asc, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { migrationsLedger } from '../../src/migrate.js';
import { queueRecipients } from '../../src/schema.js';

// Builds and inspects database files for the store's tests through Drizzle,
// so a fixture's shape is declared as tables rather than written as SQL.

export interface FixtureDb {
  client: Database.Database;
  db: BetterSQLite3Database;
}

/** Opens a file the way the store does: WAL, with the store's busy timeout. */
export function openFixture(dbPath: string): FixtureDb {
  const client = new Database(dbPath, { timeout: 5000 });
  client.pragma('journal_mode = WAL');
  return { client, db: drizzle(client) };
}

/** Creates `schema`'s tables in an empty database, from drizzle-kit's own DDL for them. */
export async function createTables(db: BetterSQLite3Database, schema: object): Promise<void> {
  const empty = await generateSQLiteDrizzleJson({});
  const target = await generateSQLiteDrizzleJson(schema as Record<string, unknown>);
  for (const statement of await generateSQLiteMigration(empty, target)) {
    db.run(sql.raw(statement));
  }
}

export function withFixture<T>(dbPath: string, fn: (fixture: FixtureDb) => T): T {
  const fixture = openFixture(dbPath);
  try {
    return fn(fixture);
  } finally {
    fixture.client.close();
  }
}

export function columnNames(dbPath: string, table: string): string[] {
  return withFixture(dbPath, ({ client }) =>
    (client.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
  );
}

export function tableNames(dbPath: string): string[] {
  return withFixture(dbPath, ({ client }) =>
    (client.pragma('table_list') as Array<{ name: string; schema: string }>)
      .filter((t) => t.schema === 'main' && !t.name.startsWith('sqlite_'))
      .map((t) => t.name)
      .sort()
  );
}

export function ledgerHashes(dbPath: string): string[] {
  return withFixture(dbPath, ({ db }) =>
    db
      .select({ hash: migrationsLedger.hash })
      .from(migrationsLedger)
      .orderBy(asc(migrationsLedger.createdAt))
      .all()
      .map((row) => row.hash)
  );
}

export function queueRecipientRows(
  dbPath: string
): Array<{ id: string; recipient: string; status: string }> {
  return withFixture(dbPath, ({ db }) =>
    db
      .select({
        id: queueRecipients.id,
        recipient: queueRecipients.recipient,
        status: queueRecipients.status,
      })
      .from(queueRecipients)
      .orderBy(asc(queueRecipients.recipient))
      .all()
  );
}
