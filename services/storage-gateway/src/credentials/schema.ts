import { sql } from 'drizzle-orm';
import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The credential store's schema. drizzle-kit diffs this file against the
// last snapshot in drizzle/ to write each new migration.

/**
 * One row per key id ever minted. Rows are never deleted, so a key id stays
 * taken for as long as the database exists: the secret is derived from the
 * key id, and a reissued id would bring a retired tenant's secret back.
 */
export const credentials = sqliteTable(
  'credentials',
  {
    keyId: text('key_id').primaryKey(),
    folder: text('folder').notNull(),
    bucket: text('bucket').notNull(),
    state: text('state', { enum: ['active', 'disabled', 'revoked'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check('credentials_state_known', sql`${table.state} IN ('active', 'disabled', 'revoked')`),
  ]
);
