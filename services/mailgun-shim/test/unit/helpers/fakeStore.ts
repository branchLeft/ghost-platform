import type {
  DueRecipient,
  QueueBatchPayload,
  QueueRecipientStatus,
  ShimStore,
  StoredEvent,
} from '../../../src/store.js';

export interface FakeShimStore extends ShimStore {
  events: StoredEvent[];
  suppressionKeys: Set<string>;
}

interface RecipientRow {
  status: QueueRecipientStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

interface BatchRow {
  domain: string;
  emailId: string | null;
  payload: QueueBatchPayload;
  createdAt: number;
  completedAt: number | null;
  recipients: Map<string, RecipientRow>;
}

function suppressionKey(domain: string, type: string, email: string): string {
  return `${domain}|${type}|${email}`;
}

/**
 * A ShimStore stand-in for route-level unit tests — plain Maps/arrays
 * instead of SQLite, so tests can assert on exactly what a route recorded
 * without a database round trip. Mirrors createSqliteStore's contract
 * (store.ts is covered directly by its own unit tests), including the
 * queue's ordering (oldest batch first, insertion order within a batch)
 * and its "no pending rows left" batch-completion rule.
 */
export function createFakeStore(): FakeShimStore {
  const tenants = new Map<string, string>();
  const suppressionKeys = new Set<string>();
  const events: StoredEvent[] = [];
  const batches = new Map<string, BatchRow>();
  let nextId = 0;

  function maybeCompleteBatch(batchId: string): void {
    const batch = batches.get(batchId);
    if (!batch || batch.completedAt !== null) {
      return;
    }
    const stillPending = [...batch.recipients.values()].some((row) => row.status === 'pending');
    if (!stillPending) {
      batch.completedAt = Date.now() / 1000;
    }
  }

  return {
    events,
    suppressionKeys,

    registerTenant(domain, apiKey) {
      tenants.set(domain, apiKey);
    },

    verifyTenant(domain, apiKey) {
      const stored = tenants.get(domain);
      return stored !== undefined && stored === apiKey ? { domain } : null;
    },

    tenantExists(domain) {
      return tenants.has(domain);
    },

    listTenants() {
      return [...tenants.keys()].sort();
    },

    recordEvent(event) {
      events.push({ ...event, id: `fake-event-${nextId++}` });
    },

    listEvents(domain, { limit, offset, eventTypes }) {
      const scoped = events.filter(
        (event) => event.domain === domain && (!eventTypes || eventTypes.includes(event.type))
      );
      const page = scoped.slice(offset, offset + limit);
      return { events: page, nextOffset: offset + page.length };
    },

    addSuppression(domain, type, email) {
      suppressionKeys.add(suppressionKey(domain, type, email));
    },

    removeSuppression(domain, type, email) {
      suppressionKeys.delete(suppressionKey(domain, type, email));
    },

    isSuppressed(domain, type, email) {
      return suppressionKeys.has(suppressionKey(domain, type, email));
    },

    enqueueBatch({ batchId, domain, emailId, payload, recipients, now }) {
      const recipientMap = new Map<string, RecipientRow>();
      for (const recipient of recipients) {
        recipientMap.set(recipient, {
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          lastError: null,
        });
      }
      batches.set(batchId, {
        domain,
        emailId,
        payload,
        createdAt: now,
        completedAt: null,
        recipients: recipientMap,
      });
    },

    claimDueRecipients(now, limit) {
      const due: DueRecipient[] = [];
      const orderedBatches = [...batches.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (const [batchId, batch] of orderedBatches) {
        for (const [recipient, row] of batch.recipients) {
          if (due.length >= limit) {
            return due;
          }
          if (row.status === 'pending' && row.nextAttemptAt <= now) {
            due.push({
              batchId,
              domain: batch.domain,
              emailId: batch.emailId,
              payload: batch.payload,
              recipient,
              attempts: row.attempts,
            });
          }
        }
      }
      return due;
    },

    recordRecipientSent(batchId, recipient, event) {
      const row = batches.get(batchId)?.recipients.get(recipient);
      if (row) {
        row.status = 'sent';
      }
      events.push({ ...event, id: `fake-event-${nextId++}` });
      maybeCompleteBatch(batchId);
    },

    recordRecipientSuppressed(batchId, recipient) {
      const row = batches.get(batchId)?.recipients.get(recipient);
      if (row) {
        row.status = 'suppressed';
      }
      maybeCompleteBatch(batchId);
    },

    scheduleRecipientRetry(batchId, recipient, attempts, nextAttemptAt, lastError) {
      const row = batches.get(batchId)?.recipients.get(recipient);
      if (row) {
        row.attempts = attempts;
        row.nextAttemptAt = nextAttemptAt;
        row.lastError = lastError;
      }
    },

    recordRecipientFailed(batchId, recipient, attempts, lastError, event) {
      const row = batches.get(batchId)?.recipients.get(recipient);
      if (row) {
        row.status = 'failed';
        row.attempts = attempts;
        row.lastError = lastError;
      }
      events.push({ ...event, id: `fake-event-${nextId++}` });
      maybeCompleteBatch(batchId);
    },

    countPendingRecipients() {
      let count = 0;
      for (const batch of batches.values()) {
        for (const row of batch.recipients.values()) {
          if (row.status === 'pending') {
            count++;
          }
        }
      }
      return count;
    },

    cleanupCompletedBatches(olderThan) {
      let deleted = 0;
      for (const [batchId, batch] of batches) {
        if (batch.completedAt !== null && batch.completedAt < olderThan) {
          batches.delete(batchId);
          deleted++;
        }
      }
      return deleted;
    },

    ping() {
      // Nothing to fail against in memory.
    },

    close() {
      // no resources to release
    },
  };
}
