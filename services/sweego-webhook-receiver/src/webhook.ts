import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import { BodyTooLargeError, readBody } from './body.js';
import type { Logger } from './log.js';
import { QueueFullError, type Queue } from './queue.js';
import { ReplayFullError, type ReplayStore } from './replay.js';
import { timestampInWindow, verifySignature } from './signature.js';
import type { Stats } from './stats.js';

export const WEBHOOK_PATH = '/webhook';
export const MAX_BODY_BYTES = 16 * 1024;
export const FUTURE_SECONDS = 5 * 60;
export const PAST_SECONDS = 2 * 60 * 60;

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const OUTCOME_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const CLASS_PATTERN = /^[a-z0-9_-]{1,32}$/;

export interface WebhookDeps {
  /** Decoded signing secrets: the current one, and the previous one during a rotation. */
  secrets: readonly Buffer[];
  queue: Queue;
  replay: ReplayStore;
  stats: Stats;
  now: () => number;
  log: Logger;
  maxBodyBytes?: number;
  /** Lower-case name of our own correlation header, looked up in the payload's header map. */
  outcomeHeader?: string;
}

export interface ServerTimeouts {
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  checkIntervalMs?: number;
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function finish(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': '0', ...extra });
  res.end();
}

function refuseOversize(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(413, { 'Cache-Control': 'no-store', 'Content-Length': '0', Connection: 'close' });
  res.end(() => req.destroy());
}

function pickOutcomeId(
  payload: Record<string, unknown>,
  headerName: string | undefined
): string | null {
  if (
    headerName !== undefined &&
    typeof payload['headers'] === 'object' &&
    payload['headers'] !== null
  ) {
    for (const [name, value] of Object.entries(payload['headers'])) {
      if (
        name.toLowerCase() === headerName &&
        typeof value === 'string' &&
        OUTCOME_ID_PATTERN.test(value)
      ) {
        return value;
      }
    }
  }
  const swg = payload['swg_uid'];
  return typeof swg === 'string' && OUTCOME_ID_PATTERN.test(swg) ? swg : null;
}

/** A short token or `unknown`: free text from the payload is never stored. */
function pickClass(payload: Record<string, unknown>): string {
  const reason = payload['reason'];
  if (typeof reason === 'string') {
    const lowered = reason.toLowerCase();
    if (CLASS_PATTERN.test(lowered)) {
      return lowered;
    }
  }
  return 'unknown';
}

export function createWebhookListener(deps: WebhookDeps): RequestListener {
  const maxBody = deps.maxBodyBytes ?? MAX_BODY_BYTES;
  const outcomeHeader = deps.outcomeHeader?.toLowerCase();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WEBHOOK_PATH) {
      finish(res, 404);
      return;
    }
    if (req.method !== 'POST') {
      finish(res, 405, { Allow: 'POST' });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBody(req, maxBody);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        deps.stats.increment('rejected_oversize');
        refuseOversize(req, res);
        return;
      }
      throw error;
    }

    const webhookId = single(req.headers['webhook-id']);
    const webhookTimestamp = single(req.headers['webhook-timestamp']);
    const signatureHeader = single(req.headers['webhook-signature']);
    if (
      webhookId === undefined ||
      webhookTimestamp === undefined ||
      signatureHeader === undefined ||
      !ID_PATTERN.test(webhookId) ||
      !verifySignature({
        secrets: deps.secrets,
        webhookId,
        webhookTimestamp,
        rawBody,
        signatureHeader,
      })
    ) {
      deps.stats.increment('rejected_signature');
      finish(res, 401);
      return;
    }
    if (!timestampInWindow(webhookTimestamp, deps.now(), FUTURE_SECONDS, PAST_SECONDS)) {
      deps.stats.increment('rejected_window');
      finish(res, 401);
      return;
    }

    // From here on the sender holds the secret: its requests may be dropped, never refused.
    const idKey = `id:${webhookId}`;
    if (deps.replay.has(idKey)) {
      deps.stats.increment('replayed');
      finish(res, 200);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      deps.stats.increment('ignored_unparseable');
      finish(res, 200);
      return;
    }

    if (payload['event_type'] !== 'complaint') {
      deps.stats.increment('ignored_event_type');
      finish(res, 200);
      return;
    }

    const eventId = payload['event_id'];
    const eventKey =
      typeof eventId === 'string' && ID_PATTERN.test(eventId) ? `ev:${eventId}` : null;
    if (eventKey !== null && deps.replay.has(eventKey)) {
      deps.stats.increment('replayed');
      finish(res, 200);
      return;
    }

    const outcomeId = pickOutcomeId(payload, outcomeHeader);
    if (outcomeId === null) {
      deps.stats.increment('ignored_no_outcome_id');
      finish(res, 200);
      return;
    }

    // Room in the replay set is checked before the queue is touched, so a full
    // replay set answers 503 with nothing queued and a retry cannot duplicate.
    // Then queue first, replay second: a failure between them costs a
    // duplicate on Sweego's retry, never a lost complaint.
    const replayKeys = eventKey === null ? [idKey] : [idKey, eventKey];
    deps.replay.assertRoom(replayKeys);
    deps.queue.append({ outcomeId, class: pickClass(payload), at: Math.floor(deps.now() / 1000) });
    deps.replay.add(replayKeys);
    deps.stats.increment('accepted');
    finish(res, 200);
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      deps.stats.increment('unavailable');
      deps.log.error('webhook_unavailable', {
        reason:
          error instanceof QueueFullError
            ? 'queue_full'
            : error instanceof ReplayFullError
              ? 'replay_full'
              : 'error',
      });
      if (!res.headersSent) {
        finish(res, 503, { 'Retry-After': '300' });
      } else {
        res.destroy();
      }
    });
  };
}

export function applyTimeouts(server: Server, timeouts: ServerTimeouts): Server {
  server.headersTimeout = timeouts.headersTimeoutMs;
  server.requestTimeout = timeouts.requestTimeoutMs;
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  server.maxHeadersCount = 50;
  return server;
}

export function createWebhookServer(deps: WebhookDeps, timeouts: ServerTimeouts): Server {
  const server = createServer(
    {
      maxHeaderSize: 8 * 1024,
      ...(timeouts.checkIntervalMs === undefined
        ? {}
        : { connectionsCheckingInterval: timeouts.checkIntervalMs }),
    },
    createWebhookListener(deps)
  );
  server.maxConnections = 64;
  return applyTimeouts(server, timeouts);
}
