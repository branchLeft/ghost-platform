/**
 * One HTTP request to one colour's Ghost over loopback, addressed as the
 * site itself (its own `Host`, behind TLS per `X-Forwarded-Proto`) so Ghost
 * answers rather than redirecting to its configured URL.
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

export interface GhostResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

export interface GhostRequest {
  readonly port: number;
  readonly siteHost: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs: number;
}

export type GhostTransport = (req: GhostRequest) => Promise<GhostResponse>;

function parseBody(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export const loopbackGhostTransport: GhostTransport = (req) =>
  new Promise((resolve, reject) => {
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
    const headers: Record<string, string> = {
      ...req.headers,
      Host: req.siteHost,
      'X-Forwarded-Proto': 'https',
      Accept: 'application/json',
    };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const outgoing = httpRequest(
      { host: '127.0.0.1', port: req.port, method: req.method, path: req.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: parseBody(Buffer.concat(chunks).toString('utf8')),
          })
        );
        res.on('error', reject);
      }
    );
    outgoing.setTimeout(req.timeoutMs, () => {
      outgoing.destroy(new Error(`Ghost did not answer ${req.method} ${req.path} in time`));
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
