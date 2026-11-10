import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { RequestListener } from 'node:http';
import type { SecureContextOptions } from 'node:tls';

export interface ListenerOptions {
  /** Present: the listener speaks TLS with this certificate and key. */
  readonly tls?: SecureContextOptions;
  /** Time allowed to receive a whole request, body included. */
  readonly requestTimeoutMs: number;
  /** Time allowed to receive a request's headers; Node requires it not to exceed the request timeout. */
  readonly headersTimeoutMs: number;
  /** How long an idle keep-alive connection is held open. */
  readonly keepAliveTimeoutMs: number;
  /** Most open connections; the next is closed at once. */
  readonly maxConnections: number;
  /**
   * True: a request that says `Expect: 100-continue` is not told to go ahead
   * until its handler calls `writeContinue`, so a client that is going to be
   * refused never sends its body.
   */
  readonly holdContinue?: boolean;
}

/** The most header bytes accepted for one request. Node's default is the same; it is pinned here. */
export const MAX_HEADER_BYTES = 16 * 1024;

export interface StopResult {
  /** True when the grace period ran out and the remaining connections were cut. */
  readonly forced: boolean;
}

/** A server with a drain: it stops taking connections, lets requests finish, then cuts what is left. */
export interface ManagedListener {
  readonly server: Server;
  listen(host: string, port: number): Promise<AddressInfo>;
  isDraining(): boolean;
  stop(graceMs: number): Promise<StopResult>;
}

const IDLE_SWEEP_MS = 100;

export function createManagedListener(
  handler: RequestListener,
  options: ListenerOptions
): ManagedListener {
  let draining = false;
  const wrapped: RequestListener = (req, res) => {
    // A draining listener answers what is in flight and asks the client not to reuse the connection.
    if (draining) res.setHeader('connection', 'close');
    handler(req, res);
  };
  const limits = {
    requestTimeout: options.requestTimeoutMs,
    headersTimeout: options.headersTimeoutMs,
    keepAliveTimeout: options.keepAliveTimeoutMs,
    maxHeaderSize: MAX_HEADER_BYTES,
  };
  const server =
    options.tls === undefined
      ? createHttpServer(limits, wrapped)
      : createHttpsServer({ ...options.tls, ...limits }, wrapped);
  server.maxConnections = options.maxConnections;
  if (options.holdContinue === true) server.on('checkContinue', wrapped);

  return {
    server,
    listen(host, port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    isDraining: () => draining,
    stop(graceMs) {
      draining = true;
      return new Promise((resolve) => {
        let forced = false;
        const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
        const cut = setTimeout(() => {
          forced = true;
          server.closeAllConnections();
        }, graceMs);
        const finish = (): void => {
          clearInterval(sweep);
          clearTimeout(cut);
          resolve({ forced });
        };
        if (!server.listening) return finish();
        server.close(finish);
        server.closeIdleConnections();
      });
    },
  };
}
