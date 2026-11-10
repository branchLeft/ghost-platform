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
}

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
  const server =
    options.tls === undefined
      ? createHttpServer({ requestTimeout: options.requestTimeoutMs }, wrapped)
      : createHttpsServer({ ...options.tls, requestTimeout: options.requestTimeoutMs }, wrapped);

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
