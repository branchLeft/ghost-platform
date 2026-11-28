import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { applyRequestTimeouts, type RequestTimeouts } from '../../src/requestTimeouts.js';

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

  async function listen(
    extra: Partial<RequestTimeouts> = {},
    answerEarly: (path: string) => number | undefined = () => undefined
  ): Promise<number> {
    // Node only looks for expired requests every `connectionsCheckingInterval`
    // (30 s by default), so a scaled-down clock needs a scaled-down check too.
    server = createServer({ connectionsCheckingInterval: 25 }, (req, res) => {
      const early = answerEarly(req.url ?? '');
      if (early !== undefined) {
        // What the broker's gate does with a push it refuses: drain, answer, leave it at that.
        req.resume();
        res.writeHead(early, { 'Content-Type': 'text/plain' });
        res.end('refused');
        return;
      }
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
      imagePushMaxTotalMs: 10_000,
      ...extra,
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

  /**
   * Raw TCP, so the sender can drip a body at its own pace after the headers:
   * resolves with what the server answered and how long the connection stayed
   * up, giving up (`closedAfterMs: undefined`) at `giveUpMs`.
   */
  function drip(
    port: number,
    opts: { everyMs: number; giveUpMs: number }
  ): Promise<{ answer: string; closedAfterMs: number | undefined }> {
    return new Promise((resolve) => {
      const started = Date.now();
      const socket = connect(port, '127.0.0.1');
      let answer = '';
      let settled = false;
      const settle = (closedAfterMs: number | undefined): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearTimeout(giveUp);
        socket.destroy();
        resolve({ answer, closedAfterMs });
      };
      socket.on('data', (chunk: Buffer) => (answer += chunk.toString()));
      socket.on('error', () => undefined);
      socket.on('close', () => settle(Date.now() - started));
      socket.write(
        'POST /image HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000000\r\nContent-Type: application/octet-stream\r\n\r\nx'
      );
      const timer = setInterval(() => socket.write('x'), opts.everyMs);
      const giveUp = setTimeout(() => settle(undefined), opts.giveUpMs);
    });
  }

  it('closes the connection of a refused image push that keeps dripping into its body', async () => {
    const port = await listen({ refusedPushLingerMs: 200 }, () => 401);
    // A drip faster than the idle clock, so only the post-answer limit can end it.
    const result = await drip(port, { everyMs: 25, giveUpMs: 2_500 });
    expect(result.answer).toMatch(/^HTTP\/1\.1 401/);
    expect(result.closedAfterMs).toBeDefined();
    expect(result.closedAfterMs ?? Infinity).toBeLessThan(1_500);
  });

  it('caps the total time of a signed image push, however steadily it moves', async () => {
    const port = await listen({ imagePushMaxTotalMs: 400 });
    // Never silent for PUSH_IDLE_MS, and never finishes: only the total cap can end it.
    const result = await send(port, '/image', { chunks: 1_000, everyMs: 20 });
    expect(result.status).toBe(408);
  });
});
