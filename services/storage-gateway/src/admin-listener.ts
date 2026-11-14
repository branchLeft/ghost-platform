import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { AdminRequest, AdminResponse } from './credentials/admin.js';

/** A mint, a disable or a state read is a few hundred bytes of JSON. */
export const ADMIN_MAX_BODY_BYTES = 16 * 1024;

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const;

export interface AdminHandler {
  handle(request: AdminRequest): AdminResponse;
}

function reply(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  for (const [name, value] of Object.entries(JSON_HEADERS)) res.setHeader(name, value);
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** Reads the whole body, or `undefined` once it passes the cap. */
async function readCapped(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const piece of req) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array | string);
    total += chunk.length;
    if (total > ADMIN_MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Adapts the admin interface to HTTP. It carries no authentication of its
 * own: the interface checks the caller's signature before it routes, so this
 * only bounds the body and hands the request over.
 */
export function createAdminHandler(admin: AdminHandler): RequestListener {
  return (req, res) => {
    void (async () => {
      const target = req.url ?? '';
      if (!target.startsWith('/') || target.includes('?')) {
        reply(res, 400, '{"error":"the request target is not valid"}');
        return;
      }
      let rawBody: Buffer | undefined;
      try {
        rawBody = await readCapped(req);
      } catch {
        res.destroy();
        return;
      }
      if (rawBody === undefined) {
        res.setHeader('connection', 'close');
        reply(res, 413, '{"error":"the request body is too large"}');
        return;
      }
      try {
        const answer = admin.handle({
          method: (req.method ?? '').toUpperCase(),
          path: target,
          headers: headersOf(req),
          rawBody,
        });
        res.statusCode = answer.status;
        for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
        res.setHeader('content-length', Buffer.byteLength(answer.body));
        res.end(answer.body);
      } catch {
        reply(res, 503, '{"error":"the admin interface failed; try again"}');
      }
    })();
  };
}
