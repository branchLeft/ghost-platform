import express, { type Request, type Response, type Router } from 'express';
import { Router as createRouter } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { requireDrainToken } from '../drainAuth.js';
import type { DrainWake } from '../drainWake.js';
import { resolveRecipientTokens } from '../mailgunFields.js';
import type { Logger } from '../log.js';
import type { DrainedRecipient, ShimStore } from '../store.js';

export interface DrainRouterOptions {
  /** How long a GET /drain request may be held open with nothing to offer, in ms. LLD-2: "held ~30s". */
  holdMs: number;
  /** How long a drained-but-unacked message stays 'held' before being re-offered under the same id. */
  leaseSeconds: number;
  /** Upper bound on messages handed over in one drain response. */
  batchLimit: number;
  /** How often a held GET /drain re-checks the store while waiting for something to become due — bounds the wake-to-response latency for anything drainWake.notify() alone doesn't cover (e.g. a lease lapsing while no new enqueue happens). */
  pollIntervalMs: number;
}

interface WireMessage {
  id: string;
  domain: string;
  emailId: string | null;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
  drainCount: number;
}

function toWireMessage(row: DrainedRecipient): WireMessage {
  const vars = row.payload.recipientVariables[row.recipient] ?? {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(row.payload.headers)) {
    if (name === 'Reply-To' || name === 'Sender') {
      continue;
    }
    headers[name] = resolveRecipientTokens(value, vars);
  }
  if (row.emailId) {
    // Carried through as a header for the drainer's own MTA logs, the same
    // correlation value Ghost's analytics job matches events back on (see
    // routes/events.ts and the old smtp.ts, before this story removed it).
    headers['X-Ghost-Email-Id'] = row.emailId;
  }

  return {
    id: row.id,
    domain: row.domain,
    emailId: row.emailId,
    from: row.payload.from,
    to: row.recipient,
    subject: resolveRecipientTokens(row.payload.subject, vars),
    html: resolveRecipientTokens(row.payload.html, vars),
    text: resolveRecipientTokens(row.payload.text, vars),
    replyTo: row.payload.headers['Reply-To'],
    headers,
    drainCount: row.drainCount,
  };
}

function parseAckIds(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const ids = (body as Record<string, unknown>).ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return null;
  }
  if (!ids.every((id): id is string => typeof id === 'string' && id.length > 0)) {
    return null;
  }
  return ids;
}

/**
 * The mail class of the drain contract LLD-2 §03 names once for the whole
 * estate ("GET /drain — long-poll, held ~30s — hands over queued mail and
 * media hashes — initiate anything: it answers, never calls") and the
 * cross-document review (P2) asks to be written down in exactly one place
 * so the backup and safety workers can reuse the shape rather than each
 * re-deriving it. This is that place, for mail:
 *
 *   GET /drain   — long-poll, held up to `holdMs`. Responds `{ messages }`,
 *                  `[]` if nothing became due before the hold expired.
 *                  Every message carries a stable `id`; claiming it moves
 *                  it to a leased 'held' state (claimForDrain) rather than
 *                  removing it — a crash before the matching ack causes it
 *                  to be re-offered under the same id once the lease lapses.
 *   POST /drain/ack — body `{ ids: string[] }`. Marks every id whose
 *                  message this drainer actually took delivery of. A
 *                  message leaves the queue for good only here. Acking an
 *                  id twice, or an id whose lease already lapsed and was
 *                  reclaimed, is reported back rather than erroring —
 *                  `alreadyHandled` / `unknown` — so a drainer that crashed
 *                  between receiving a batch and acking it can find out
 *                  what actually landed rather than guessing.
 *
 * Both routes require requireDrainToken — the collector's only credential.
 * Neither route ever opens an outbound connection: this module only reads
 * from and writes to `store`, and answers the request already open. Making
 * that true is what the rest of this story's changes (removing worker.ts
 * and smtp.ts's outbound transport entirely) exist to guarantee — this
 * route could not dial out even if it tried, because nothing importable
 * from here can construct an outbound transport any more.
 */
export function createDrainRouter(
  store: ShimStore,
  wake: DrainWake,
  drainToken: string,
  options: DrainRouterOptions,
  log: Logger,
  now: () => number = () => Date.now() / 1000
): Router {
  const router = createRouter();
  const auth = requireDrainToken(drainToken);

  router.get(
    '/drain',
    auth,
    asyncHandler(log, async (_req: Request, res: Response) => {
      const deadline = Date.now() + options.holdMs;

      for (;;) {
        const drained = store.claimForDrain(now(), options.leaseSeconds, options.batchLimit);
        if (drained.length > 0) {
          log.info('drain', { count: drained.length, ids: drained.map((r) => r.id) });
          res.status(200).json({ messages: drained.map(toWireMessage) });
          return;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          res.status(200).json({ messages: [] });
          return;
        }

        await wake.waitForSignal(Math.min(remaining, options.pollIntervalMs));
      }
    })
  );

  router.post(
    '/drain/ack',
    auth,
    express.json({ limit: '256kb' }),
    asyncHandler(log, async (req: Request, res: Response) => {
      const ids = parseAckIds(req.body);
      if (!ids) {
        res.status(400).json({ message: 'Body must be { ids: string[] } with at least one id' });
        return;
      }

      const result = store.ackDrain(ids, now());
      log.info('drain_ack', {
        acked: result.acked.length,
        alreadyHandled: result.alreadyHandled.length,
        unknown: result.unknown.length,
      });
      res.status(200).json(result);
    })
  );

  return router;
}
