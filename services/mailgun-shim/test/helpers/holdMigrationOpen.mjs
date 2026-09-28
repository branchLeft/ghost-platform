// Usage: node holdMigrationOpen.mjs <db path> <hold ms>
// Migrates the file inside the store's IMMEDIATE transaction, prints
// "migrated-uncommitted", then holds the transaction open for <hold ms>
// before committing — a first opener caught mid-migration.
import { writeSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { applyMigrations, MIGRATIONS_FOLDER } from '../../dist/migrate.js';

const [dbPath, holdMs] = process.argv.slice(2);
const client = new Database(dbPath, { timeout: 5000 });
client.pragma('journal_mode = WAL');
const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
drizzle(client).transaction(
  (tx) => {
    applyMigrations(tx, client, migrations);
    // writeSync: an asynchronous stdout pipe would not flush while the wait below blocks.
    writeSync(1, 'migrated-uncommitted\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  },
  { behavior: 'immediate' }
);
client.close();
