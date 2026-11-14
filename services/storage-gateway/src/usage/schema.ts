import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The write ledger's schema, in its own SQLite file apart from the credential
// store. drizzle-kit diffs this file against the last snapshot in
// drizzle/usage/ to write each new migration (drizzle.usage.config.ts).

/** One row per write, never updated or deleted: erasure is checked against it. */
export const writeLedger = sqliteTable(
  'write_ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    keyId: text('key_id').notNull(),
    folder: text('folder').notNull(),
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),
    size: integer('size').notNull(),
    operation: text('operation').notNull(),
    writtenAt: text('written_at').notNull(),
  },
  (table) => [
    index('write_ledger_by_folder').on(table.folder, table.objectKey),
    check('write_ledger_size_nonnegative', sql`${table.size} >= 0`),
  ]
);

/** The size of each part of an unfinished multipart upload, replaced on resend. */
export const multipartParts = sqliteTable(
  'multipart_parts',
  {
    keyId: text('key_id').notNull(),
    uploadId: text('upload_id').notNull(),
    partNumber: integer('part_number').notNull(),
    size: integer('size').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.keyId, table.uploadId, table.partNumber] }),
    check('multipart_parts_size_nonnegative', sql`${table.size} >= 0`),
  ]
);

/** Per-tenant, per-operation counts that survive a restart. */
export const usageCounters = sqliteTable(
  'usage_counters',
  {
    keyId: text('key_id').notNull(),
    operation: text('operation').notNull(),
    requests: integer('requests').notNull(),
    billableIn: integer('billable_in').notNull(),
    billableOut: integer('billable_out').notNull(),
  },
  (table) => [primaryKey({ columns: [table.keyId, table.operation] })]
);
