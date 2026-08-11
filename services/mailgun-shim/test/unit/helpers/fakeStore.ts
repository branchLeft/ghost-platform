import type { ShimStore, StoredEvent } from '../../../src/store.js';

export interface FakeShimStore extends ShimStore {
  events: StoredEvent[];
  suppressionKeys: Set<string>;
}

function suppressionKey(domain: string, type: string, email: string): string {
  return `${domain}|${type}|${email}`;
}

/**
 * A ShimStore stand-in for route-level unit tests — plain Maps/arrays
 * instead of SQLite, so tests can assert on exactly what a route recorded
 * without a database round trip. Mirrors createSqliteStore's contract
 * (store.ts is covered directly by its own unit tests).
 */
export function createFakeStore(): FakeShimStore {
  const tenants = new Map<string, string>();
  const suppressionKeys = new Set<string>();
  const events: StoredEvent[] = [];
  let nextId = 0;

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

    close() {
      // no resources to release
    },
  };
}
