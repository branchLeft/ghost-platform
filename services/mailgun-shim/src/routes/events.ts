import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { requireTenantForDomain } from '../auth.js';
import { tenantRateLimiter } from '../rateLimit.js';
import type { ShimStore, StoredEvent } from '../store.js';

const DEFAULT_LIMIT = 300;

function parseEventTypeFilter(rawEvent: string | undefined): string[] | undefined {
  // Ghost only ever sends an OR-list of exact type names
  // (email-analytics-provider-mailgun.js: `event.join(' OR ')`), never
  // Mailgun's fuller boolean search grammar — matching on that list covers
  // every real caller.
  if (!rawEvent) {
    return undefined;
  }
  return rawEvent.split(' OR ').map((s) => s.trim());
}

function toWireEvent(event: StoredEvent) {
  return {
    id: event.id,
    event: event.type,
    severity: event.severity ?? undefined,
    recipient: event.recipient,
    timestamp: event.timestamp,
    message: {
      headers: {
        'message-id': event.providerMessageId ?? undefined,
      },
    },
    'user-variables': {
      'email-id': event.emailId ?? undefined,
    },
    ...(event.errorCode || event.errorMessage
      ? {
          'delivery-status': {
            code: event.errorCode ?? undefined,
            message: event.errorMessage ?? undefined,
          },
        }
      : {}),
  };
}

export function createEventsRouter(store: ShimStore): Router {
  const router = createRouter();

  const handler = (req: Request, res: Response): void => {
    const domain = req.params.domain as string;
    const limit = Number(req.query.limit) || DEFAULT_LIMIT;
    // mailgun.js's pagination appends the opaque cursor as a literal extra
    // path segment after "events" (verified by instrumenting the real
    // client's request layer — Events#get -> requestListWithPages ->
    // updateUrlAndQuery joins `page` onto the URL path, not a query
    // param), so both routes below share this handler.
    const offset = req.params.cursor ? Number(req.params.cursor) || 0 : 0;
    const eventTypes = parseEventTypeFilter(req.query.event as string | undefined);

    const { events, nextOffset } = store.listEvents(domain, { limit, offset, eventTypes });

    const baseUrl = `${req.protocol}://${req.get('host')}/v3/${domain}/events`;
    const nextUrl = `${baseUrl}/${nextOffset}`;
    const firstUrl = `${baseUrl}/0`;
    const previousUrl = `${baseUrl}/${offset}`;

    res.status(200).json({
      items: events.map(toWireEvent),
      paging: {
        previous: previousUrl,
        first: firstUrl,
        // "last" can't be computed honestly without a total count this
        // skeleton doesn't track, and Ghost's client never reads it
        // (only `paging.next` drives its pagination loop) — pointing it at
        // `next` keeps the wire shape complete without fabricating a
        // number that would look precise but isn't.
        last: nextUrl,
        next: nextUrl,
      },
    });
  };

  const limiter = tenantRateLimiter(120);
  router.get('/v3/:domain/events', limiter, requireTenantForDomain(store), handler);
  router.get('/v3/:domain/events/:cursor', limiter, requireTenantForDomain(store), handler);

  return router;
}
