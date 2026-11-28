import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { applyRequestTimeouts } from '../../src/requestTimeouts.js';

/**
 * Seen live: a docker-save tar pushed over a two-hop SSH tunnel took longer
 * than the broker's whole-request `requestTimeout` (max(60 s, drain poll +
 * 10 s), so at most 130 s) and the broker answered 408 for a push that was
 * moving the whole time. The clocks here are scaled down (hundreds of ms for
 * what is a minute in production); the shape is the same.
 */
describe('applyRequestTimeouts (the image push is not cut off by the whole-request clock)', () => {
  const WHOLE_REQUEST_MS = 300;
  const PUSH_IDLE_MS = 300;
  let server: Server | undefined;

  afterEach(async () => {
    const s = server;
    server = undefined;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  async function listen(): Promise<number> {
    // Node only looks for expired requests every `connectionsCheckingInterval`
    // (30 s by default), so a scaled-down clock needs a scaled-down check too.
    server = createServer({ connectionsCheckingInterval: 25 }, (req, res) => {
      let bytes = 0;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      req.on('error', () => undefined);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(String(bytes));
      });
    });
    applyRequestTimeouts(server, {
      headersTimeoutMs: 200, // below the scaled whole-request clock, as 10 s is below 60 s
      requestTimeoutMs: WHOLE_REQUEST_MS,
      imagePushIdleTimeoutMs: PUSH_IDLE_MS,
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  /**
   * Sends `chunks` pieces of body, one every `everyMs`, then ends it (unless
   * `stallAfterChunks` says to go silent instead). Resolves with the status
   * the server answered, or `'closed'` if it only dropped the connection.
   */
  function send(
    port: number,
    path: string,
    opts: { chunks: number; everyMs: number; stallAfter?: number }
  ): Promise<{ status: number | 'closed'; body: string }> {
    return new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', agent: false });
      let settled = false;
      const settle = (status: number | 'closed', body: string): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        req.destroy();
        resolve({ status, body });
      };
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => settle(res.statusCode ?? 0, body));
        res.on('error', () => settle(res.statusCode ?? 0, body));
      });
      req.on('error', () => settle('closed', ''));
      let sent = 0;
      req.write('x'); // headers and first byte out
      const timer = setInterval(() => {
        if (opts.stallAfter !== undefined && sent >= opts.stallAfter) return;
        if (sent >= opts.chunks) {
          req.end();
          clearInterval(timer);
          return;
        }
        sent++;
        req.write('x'.repeat(1024));
      }, opts.everyMs);
    });
  }

  it('lets an image push that keeps moving run far past the whole-request clock', async () => {
    const port = await listen();
    // ~1.2 s of steady progress, four times WHOLE_REQUEST_MS, never silent for PUSH_IDLE_MS.
    const result = await send(port, '/image', { chunks: 24, everyMs: 50 });
    expect(result).toEqual({ status: 200, body: String(1 + 24 * 1024) });
  });

  it('still refuses an image push that stalls: 408, connection closed', async () => {
    const port = await listen();
    const result = await send(port, '/image', { chunks: 24, everyMs: 50, stallAfter: 3 });
    expect(result.status).toBe(408);
  });

  it('keeps the whole-request clock on every other route, even one that keeps moving', async () => {
    const port = await listen();
    const result = await send(port, '/reconcile', { chunks: 24, everyMs: 50 });
    expect(result.status).toBe(408);
  });

  it('does not clock a quick request on another route', async () => {
    const port = await listen();
    const result = await send(port, '/reconcile', { chunks: 2, everyMs: 20 });
    expect(result.status).toBe(200);
  });
});
