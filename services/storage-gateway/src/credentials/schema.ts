import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    disabledAt: text('disabled_at'),
    // The tenant's upload ceiling in MiB. Mint requires it and the upload path
    // refuses NULL. The column stays nullable: SQLite cannot add a NOT NULL
    // column without a default, and a default would be a guessed limit.
    uploadCeilingMib: integer('upload_ceiling_mib'),
  },
  (table) => [
    check('credentials_state_known', sql`${table.state} IN ('active', 'disabled', 'revoked')`),
    // A stored ceiling is never a value the body stage would refuse: NULL, or a
    // positive whole number. A bad value cannot be written even by a direct write.
    check(
      'credentials_upload_ceiling_valid',
      sql`${table.uploadCeilingMib} IS NULL OR (typeof(${table.uploadCeilingMib}) = 'integer' AND ${table.uploadCeilingMib} > 0)`
    ),
    // At most one active credential per folder: a retried mint cannot leave
    // a second, unrecorded key able to write into the tenant's folder.
    uniqueIndex('uniq_credentials_active_folder')
      .on(table.folder)
      .where(sql`${table.state} = 'active'`),
  ]
);
