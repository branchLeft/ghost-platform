import { randomUUID } from 'node:crypto';
import { isSafeRecipientAddress } from '../../../src/recipientSafety.js';
import { SUPPRESSION_TYPES } from '../../../src/store.js';
import type {
  AckDrainResult,
  DrainedRecipient,
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
  id: string;
  recipient: string;
  status: QueueRecipientStatus;
  drainCount: number;
  availableAt: number;
  heldUntil: number | null;
}

interface BatchRow {
  batchId: string;
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
 * queue's ordering (oldest batch first, insertion order within a batch),
 * its "no pending/held rows left" batch-completion rule, and the
 * claim/lease/ack shape claimForDrain and ackDrain give real drainers.
 */
export function createFakeStore(): FakeShimStore {
  const tenants = new Map<string, string>();
  const suppressionKeys = new Set<string>();
  const events: StoredEvent[] = [];
  const batches = new Map<string, BatchRow>();
  const recipientIndex = new Map<string, { batchId: string; recipient: string }>();
  let nextId = 0;

  function maybeCompleteBatch(batchId: string, now: number): void {
    const batch = batches.get(batchId);
    if (!batch || batch.completedAt !== null) {
      return;
    }
    const outstanding = [...batch.recipients.values()].some(
      (row) => row.status === 'pending' || row.status === 'held'
    );
    if (!outstanding) {
      batch.completedAt = now;
    }
  }

  function isSuppressed_(domain: string, recipient: string): boolean {
    return SUPPRESSION_TYPES.some((type) =>
      suppressionKeys.has(suppressionKey(domain, type, recipient))
    );
  }

  return {
    events,
    suppressionKeys,

    registerTenant(domain, apiKey) {
      tenants.set(domain, apiKey);
    },

    async verifyTenant(domain, apiKey) {
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
        if (recipientMap.has(recipient)) {
          // Mirrors createSqliteStore's PRIMARY KEY (batch_id, recipient)
          // constraint — a Map.set with a repeated key would otherwise
          // silently overwrite instead of surfacing the same conflict a
          // real duplicate-recipient request produces against sqlite. A
          // caller (the messages route) must dedupe before this is called.
          throw new Error(
            `UNIQUE constraint failed: queue_recipients.batch_id, queue_recipients.recipient (duplicate recipient "${recipient}" in batch "${batchId}")`
          );
        }
        const id = randomUUID();
        recipientMap.set(recipient, {
          id,
          recipient,
          status: 'pending',
          drainCount: 0,
          availableAt: now,
          heldUntil: null,
        });
        recipientIndex.set(id, { batchId, recipient });
      }
      batches.set(batchId, {
        batchId,
        domain,
        emailId,
        payload,
        createdAt: now,
        completedAt: null,
        recipients: recipientMap,
      });
    },

    claimForDrain(now, leaseSeconds, limit, canSend) {
      const drained: DrainedRecipient[] = [];
      const orderedBatches = [...batches.values()].sort((a, b) => a.createdAt - b.createdAt);

      outer: for (const batch of orderedBatches) {
        for (const row of batch.recipients.values()) {
          if (drained.length >= limit) {
            break outer;
          }
          const claimable =
            (row.status === 'pending' && row.availableAt <= now) ||
            (row.status === 'held' && row.heldUntil !== null && row.heldUntil <= now);
          if (!claimable) {
            continue;
          }

          if (isSuppressed_(batch.domain, row.recipient)) {
            row.status = 'suppressed';
            row.heldUntil = null;
            maybeCompleteBatch(batch.batchId, now);
            continue;
          }

          if (!isSafeRecipientAddress(row.recipient)) {
            row.status = 'failed';
            row.heldUntil = null;
            maybeCompleteBatch(batch.batchId, now);
            continue;
          }

          if (canSend && !canSend()) {
            break outer;
          }

          row.status = 'held';
          row.drainCount += 1;
          row.heldUntil = now + leaseSeconds;
          drained.push({
            id: row.id,
            batchId: batch.batchId,
            domain: batch.domain,
            emailId: batch.emailId,
            payload: batch.payload,
            recipient: row.recipient,
            drainCount: row.drainCount,
          });
        }
      }

      return drained;
    },

    ackDrain(acks, now) {
      const result: AckDrainResult = { acked: [], alreadyHandled: [], unknown: [] };
      for (const { id, drainCount } of acks) {
        const location = recipientIndex.get(id);
        const row = location
          ? batches.get(location.batchId)?.recipients.get(location.recipient)
          : undefined;
        if (!row) {
          result.unknown.push(id);
          continue;
        }
        if (row.status === 'sent') {
          result.alreadyHandled.push(id);
          continue;
        }
        if (row.status !== 'held') {
          result.unknown.push(id);
          continue;
        }
        if (row.drainCount !== drainCount) {
          // Held, but at a newer generation than this ack names — a late
          // ack from a superseded claim (see store.ts's own ackDrain doc).
          result.unknown.push(id);
          continue;
        }
        row.status = 'sent';
        row.heldUntil = null;
        maybeCompleteBatch(location!.batchId, now);
        result.acked.push(id);
      }
      return result;
    },

    oldestUndrainedAgeSeconds(now) {
      let oldest: number | null = null;
      for (const batch of batches.values()) {
        const outstanding = [...batch.recipients.values()].some(
          (row) => row.status === 'pending' || row.status === 'held'
        );
        if (outstanding && (oldest === null || batch.createdAt < oldest)) {
          oldest = batch.createdAt;
        }
      }
      return oldest === null ? null : now - oldest;
    },

    countUndrainedRecipients() {
      let count = 0;
      for (const batch of batches.values()) {
        for (const row of batch.recipients.values()) {
          if (row.status === 'pending' || row.status === 'held') {
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
          for (const row of batch.recipients.values()) {
            recipientIndex.delete(row.id);
          }
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
