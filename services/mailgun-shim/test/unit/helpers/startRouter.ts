import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Router } from 'express';

export interface StartedRouter {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Mounts a single router in isolation for a route-level unit test — no
 * SQLite, no SMTP, no full createApp() wiring, just the one router under
 * test on an ephemeral loopback port so the real Express request/response
 * cycle (multipart parsing, headers, status codes) is exercised without a
 * network hop.
 */
export function startRouter(router: Router): Promise<StartedRouter> {
  const app = express();
  app.use(router);

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close() {
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
    server.on('error', reject);
  });
}

export function basicAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
