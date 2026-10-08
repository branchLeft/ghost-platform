import express, { type Request, type Response, type Router } from 'express';
import { Router as createRouter } from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { requireDrainToken } from '../drainAuth.js';
import type { DrainWake } from '../drainWake.js';
import { resolveRecipientTokens } from '../mailgunFields.js';
import type { Logger } from '../log.js';
import type { AckRequest, DrainedRecipient, OutcomeRequest, ShimStore } from '../store.js';
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
  /**
   * Serves POST /drain/outcomes. Off unless explicitly true: an unset value
   * leaves the route unregistered (404), so a shim that has not opted in
   * behaves exactly as before this route existed. See drain.md#outcomes.
   */
  outcomesEnabled?: boolean;
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

const MAX_OUTCOMES_PER_REQUEST = 200;

/**
 * `{ outcomes: [{ id, drainCount, outcome: 'delivered' | 'failed',
 * severity?: 'permanent' | 'temporary', code?, message? }] }`. A 'failed'
 * outcome must name its severity: defaulting one would either suppress an
 * address on a transient fault or hide a real bounce.
 */
function parseOutcomes(body: unknown): OutcomeRequest[] | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const list = (body as Record<string, unknown>).outcomes;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_OUTCOMES_PER_REQUEST) {
    return null;
  }
  const parsed: OutcomeRequest[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const { id, drainCount, outcome, severity, code, message } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || !isPositiveInteger(drainCount)) {
      return null;
    }
    if (outcome !== 'delivered' && outcome !== 'failed') {
      return null;
    }
    if (outcome === 'failed' && severity !== 'permanent' && severity !== 'temporary') {
      return null;
    }
    if (code !== undefined && (typeof code !== 'number' || !Number.isInteger(code))) {
      return null;
    }
    if (message !== undefined && typeof message !== 'string') {
      return null;
    }
    parsed.push({
      id,
      drainCount,
      outcome,
      ...(outcome === 'failed' ? { severity: severity as 'permanent' | 'temporary' } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message: message.slice(0, 500) } : {}),
    });
  }
  return parsed;
}

/**
 * GET /drain long-polls and leases messages; POST /drain/ack names
 * { id, drainCount } and is the only way a message leaves the queue.
 * See drain.md#the-drain-contract.
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

      // A held GET can outlive its client; the loop stops before claiming
      // for a connection already known to be gone.
      // See drain.md#a-held-request-whose-client-has-gone.
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

  if (options.outcomesEnabled === true) {
    router.post(
      '/drain/outcomes',
      auth,
      express.json({ limit: '256kb' }),
      asyncHandler(log, async (req: Request, res: Response) => {
        const outcomes = parseOutcomes(req.body);
        if (!outcomes) {
          res.status(400).json({
            message: `Body must be { outcomes: [{ id, drainCount, outcome: 'delivered' | 'failed', severity (required for failed) }] } with 1 to ${MAX_OUTCOMES_PER_REQUEST} entries`,
          });
          return;
        }
        const result = store.recordOutcomes(outcomes, now());
        log.info('drain_outcomes', {
          recorded: result.recorded.length,
          alreadyHandled: result.alreadyHandled.length,
          unknown: result.unknown.length,
        });
        res.status(200).json(result);
      })
    );
  }

  return router;
}
