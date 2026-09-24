import express, { type Request, type Response, type Router } from 'express';
import { Router as createRouter } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { requireDrainToken } from '../drainAuth.js';
import type { DrainWake } from '../drainWake.js';
import { resolveRecipientTokens } from '../mailgunFields.js';
import type { Logger } from '../log.js';
import type { AckRequest, DrainedRecipient, ShimStore } from '../store.js';
import type { Throttle } from '../throttle.js';

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
  /** The recipient-variables `name`, when present — a drainer formatting `{name, address}` (the old worker's shape) needs it separately from `to`, which stays a bare address. */
  toName?: string;
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
    toName: vars.name,
    subject: resolveRecipientTokens(row.payload.subject, vars),
    html: resolveRecipientTokens(row.payload.html, vars),
    text: resolveRecipientTokens(row.payload.text, vars),
    replyTo: row.payload.headers['Reply-To'],
    headers,
    drainCount: row.drainCount,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * `{ acks: [{ id, drainCount }] }` — drainCount is required, not optional:
 * it is what lets ackDrain (store.ts) tell a current claim from a
 * superseded one apart, so a request naming an id with no drainCount is
 * malformed the same way one with no id would be, not defaulted.
 */
function parseAcks(body: unknown): AckRequest[] | null {
  /* v8 ignore start -- express.json() defaults to strict mode, which
   * refuses any top-level JSON value that isn't an object or array
   * (verified empirically: a raw `null` body never reaches this function
   * at all — body-parser's own regex check on the raw text rejects it
   * with a 400 from Express's default error handler first). Kept as a
   * defensive check rather than an assumed invariant, in case that
   * middleware option is ever relaxed. */
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  /* v8 ignore stop */
  const acks = (body as Record<string, unknown>).acks;
  if (!Array.isArray(acks) || acks.length === 0) {
    return null;
  }
  const parsed: AckRequest[] = [];
  for (const entry of acks) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const { id, drainCount } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || !isPositiveInteger(drainCount)) {
      return null;
    }
    parsed.push({ id, drainCount });
  }
  return parsed;
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
 *                  Every message carries a stable `id` and the `drainCount`
 *                  this hand-over was made under; claiming it moves the row
 *                  to a leased 'held' state (claimForDrain) rather than
 *                  removing it — a crash before the matching ack causes it
 *                  to be re-offered under the same id, at the next
 *                  `drainCount`, once the lease lapses. If the client
 *                  disconnects while this request is held open, the loop
 *                  notices before its next claim attempt and stops without
 *                  claiming anything on that abandoned connection's behalf
 *                  — see the disconnect check below.
 *   POST /drain/ack — body `{ acks: [{ id, drainCount }] }`. Marks every
 *                  id whose message this drainer actually took delivery
 *                  of, PROVIDED the `drainCount` named still matches the
 *                  row's current one — an ack naming a `drainCount` the
 *                  row has since moved past (the lease lapsed and it was
 *                  re-offered, to this drainer again or to another one, in
 *                  between) is a late ack from a superseded claim, and is
 *                  reported `unknown` rather than accepted. A message
 *                  leaves the queue for good only here. Acking an id twice
 *                  at its current generation, or one that's stale, is
 *                  reported back rather than erroring — `alreadyHandled` /
 *                  `unknown` — so a drainer that crashed between receiving
 *                  a batch and acking it can find out what actually landed
 *                  rather than guessing.
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
  throttle: Throttle,
  now: () => number = () => Date.now() / 1000
): Router {
  const router = createRouter();
  const auth = requireDrainToken(drainToken);

  router.get(
    '/drain',
    auth,
    asyncHandler(log, async (req: Request, res: Response) => {
      const deadline = Date.now() + options.holdMs;

      // A held GET can outlive its own client: the collector crashes, the
      // network drops, or it simply gives up. Without this, the loop below
      // would still call claimForDrain() on its next wake and lease a
      // message that can never be delivered on this connection — spending
      // a throttle token and a lease for nothing (the row does eventually
      // come back once the lease lapses, but only after sitting uselessly
      // "drained" the whole time). `req.on('close', ...)` fires on a
      // genuine client disconnect as well as on normal completion, so the
      // flag is only trusted before a response has actually been sent —
      // checked, never written to after headersSent, which res.json()
      // below sets synchronously in the same tick it writes.
      // Not airtight against the OS's own reporting delay — a message
      // that becomes available in the narrow window between the actual
      // disconnect and Node learning about it can still be claimed once
      // before this catches up. What it does close is the case that
      // otherwise never recovers on its own within the hold: an
      // already-known-gone connection's loop waking on a later
      // wake()/poll and claiming regardless.
      let clientGone = false;
      req.on('close', () => {
        if (!res.headersSent) {
          clientGone = true;
        }
      });

      for (;;) {
        if (clientGone) {
          log.info('drain_abandoned', {});
          return;
        }

        // Re-read on every poll iteration, not once per request: a request
        // held open across the whole holdMs window (LLD-2: "held ~30s")
        // must still pick up an operator's throttle-file edit within that
        // one hold, not only on the next request. reload() is a single
        // stat() call when nothing changed, so this costs nothing on the
        // common path.
        throttle.reload();
        const drained = store.claimForDrain(now(), options.leaseSeconds, options.batchLimit, () =>
          throttle.tryTake()
        );
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
      const acks = parseAcks(req.body);
      if (!acks) {
        res.status(400).json({
          message:
            'Body must be { acks: [{ id: string, drainCount: number }] } with at least one entry',
        });
        return;
      }

      const result = store.ackDrain(acks, now());
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
