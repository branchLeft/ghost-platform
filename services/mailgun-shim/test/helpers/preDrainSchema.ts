import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The store's schema before the drain handover: what a live host still runs.
// Kept independent of src/schema.ts so it goes on describing the old shape
// whatever the current one becomes. See ../../src/store.md#schema-and-migrations.

export const tenants = sqliteTable('tenants', {
  domain: text('domain').primaryKey(),
  apiKeySalt: text('api_key_salt').notNull(),
  apiKeyHash: text('api_key_hash').notNull(),
});

export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    domain: text('domain').notNull(),
    type: text('type').notNull(),
    severity: text('severity'),
    recipient: text('recipient').notNull(),
    emailId: text('email_id'),
    providerMessageId: text('provider_message_id'),
    timestamp: real('timestamp').notNull(),
    errorCode: integer('error_code'),
    errorMessage: text('error_message'),
  },
  (table) => [index('idx_events_domain_seq').on(table.domain, table.seq)]
);

export const suppressions = sqliteTable(
  'suppressions',
  {
    domain: text('domain').notNull(),
    type: text('type').notNull(),
    email: text('email').notNull(),
  },
  (table) => [primaryKey({ columns: [table.domain, table.type, table.email] })]
);

export const queueBatches = sqliteTable('queue_batches', {
  batchId: text('batch_id').primaryKey(),
  domain: text('domain').notNull(),
  emailId: text('email_id'),
  payload: text('payload').notNull(),
  createdAt: real('created_at').notNull(),
  completedAt: real('completed_at'),
});

export const queueRecipients = sqliteTable(
  'queue_recipients',
  {
    batchId: text('batch_id').notNull(),
    recipient: text('recipient').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: real('next_attempt_at').notNull(),
    lastError: text('last_error'),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.recipient] }),
    index('idx_queue_recipients_status_next').on(table.status, table.nextAttemptAt),
  ]
);
