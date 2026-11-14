import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import { bearerMatches } from './bearer.js';
import { BodyTooLargeError, readBody } from './body.js';
import type { Logger } from './log.js';
import type { Queue } from './queue.js';
import type { Stats } from './stats.js';
import { applyTimeouts, type ServerTimeouts } from './webhook.js';

const ACK_BODY_MAX_BYTES = 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface DrainDeps {
  queue: Queue;
  stats: Stats;
  log: Logger;
  /** The drain port's only credential. */
  token: string;
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {}
): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function intParam(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null) {
    return fallback;
  }
  if (!/^[0-9]{1,9}$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/**
 * Pull API for the collector, on its own port bound to the private address.
 * The token is checked before the route, the method or any parameter is
 * looked at, so an unauthenticated caller learns nothing about the surface.
 *   GET  /drain?after=N&limit=M   records with seq > N, oldest first
 *   POST /drain/ack {"through":N} release records up to N once held
 *   GET  /stats                   counters
 */
export function createDrainListener(deps: DrainDeps): RequestListener {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!bearerMatches(req.headers.authorization, deps.token)) {
      json(res, 401, { message: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://drain.invalid');

    if (url.pathname === '/drain' && req.method === 'GET') {
      const after = intParam(
        url.searchParams.get('after'),
        deps.queue.stats().acked,
        0,
        Number.MAX_SAFE_INTEGER
      );
      const limit = intParam(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
      if (after === null || limit === null) {
        json(res, 400, { message: 'Bad parameter' });
        return;
      }
      json(res, 200, { records: deps.queue.read(after, limit) });
      return;
    }

    if (url.pathname === '/drain/ack' && req.method === 'POST') {
      let body: Buffer;
      try {
        body = await readBody(req, ACK_BODY_MAX_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          res.writeHead(413, { 'Content-Length': '0', Connection: 'close' });
          res.end(() => req.destroy());
          return;
        }
        throw error;
      }
      let through: unknown;
      try {
        through = (JSON.parse(body.toString('utf8')) as { through?: unknown }).through;
      } catch {
        through = undefined;
      }
      if (typeof through !== 'number' || !Number.isInteger(through)) {
        json(res, 400, { message: 'Bad body' });
        return;
      }
      try {
        json(res, 200, { removed: deps.queue.ack(through) });
      } catch (error) {
        if (error instanceof RangeError) {
          json(res, 400, { message: 'Ack is beyond the queue' });
          return;
        }
        throw error;
      }
      return;
    }

    if (url.pathname === '/stats' && req.method === 'GET') {
      json(res, 200, { counters: deps.stats.snapshot(), queue: deps.queue.stats() });
      return;
    }

    json(res, 404, { message: 'Not found' });
  }

  return (req, res) => {
    handle(req, res).catch(() => {
      deps.log.error('drain_unavailable');
      if (!res.headersSent) {
        json(res, 503, { message: 'Unavailable' });
      } else {
        res.destroy();
      }
    });
  };
}

export function createDrainServer(deps: DrainDeps, timeouts: ServerTimeouts): Server {
  const server = createServer(
    {
      maxHeaderSize: 8 * 1024,
      ...(timeouts.checkIntervalMs === undefined
        ? {}
        : { connectionsCheckingInterval: timeouts.checkIntervalMs }),
    },
    createDrainListener(deps)
  );
  server.maxConnections = 16;
  return applyTimeouts(server, timeouts);
}
