import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// The store's schema. drizzle-kit diffs this file against drizzle/'s last
// snapshot to write each new migration; see store.md#schema-and-migrations.

export const tenants = sqliteTable('tenants', {
  domain: text('domain').primaryKey(),
  apiKeySalt: text('api_key_salt').notNull(),
  apiKeyHash: text('api_key_hash').notNull(),
  senderDomain: text('sender_domain'),
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

// `id` is the drain-facing identity, stable across re-offers; the primary key
// stays (batch_id, recipient) because enqueue de-duplication relies on it.
export const queueRecipients = sqliteTable(
  'queue_recipients',
  {
    id: text('id').notNull(),
    batchId: text('batch_id').notNull(),
    recipient: text('recipient').notNull(),
    status: text('status').notNull().default('pending'),
    drainCount: integer('drain_count').notNull().default(0),
    availableAt: real('available_at').notNull(),
    heldUntil: real('held_until'),
    lastError: text('last_error'),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.recipient] }),
    uniqueIndex('idx_queue_recipients_id').on(table.id),
    index('idx_queue_recipients_status_available').on(table.status, table.availableAt),
    index('idx_queue_recipients_status_held_until').on(table.status, table.heldUntil),
  ]
);
