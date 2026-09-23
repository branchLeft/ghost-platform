import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpGhostProbe } from '../../src/ghostProbe.js';

interface FakeGhost {
  url: string;
  close: () => Promise<void>;
}

function startFakeGhost(
  handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void
): Promise<FakeGhost> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}

describe('createHttpGhostProbe', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('is healthy on a 200', async () => {
    const fake = await startFakeGhost((_req, res) => res.writeHead(200).end('ok'));
    close = fake.close;
    const probe = createHttpGhostProbe(fake.url, 1000);
    expect(await probe.isHealthy()).toBe(true);
  });

  it('is unhealthy on a non-200 -- Ghost answering is not the same as Ghost being well', async () => {
    const fake = await startFakeGhost((_req, res) => res.writeHead(503).end());
    close = fake.close;
    const probe = createHttpGhostProbe(fake.url, 1000);
    expect(await probe.isHealthy()).toBe(false);
  });

  it('is unhealthy, not throwing, when nothing is listening', async () => {
    const probe = createHttpGhostProbe('http://127.0.0.1:1/', 500);
    await expect(probe.isHealthy()).resolves.toBe(false);
  });

  it('is unhealthy on a timeout rather than hanging the caller', async () => {
    const fake = await startFakeGhost(() => {
      // Deliberately never responds -- proves the abort actually fires
      // rather than the request completing before the assertion runs.
    });
    close = fake.close;
    const probe = createHttpGhostProbe(fake.url, 100);
    await expect(probe.isHealthy()).resolves.toBe(false);
  });

  it('sends X-Forwarded-Proto: https so a Ghost that redirects insecure requests reads healthy', async () => {
    const fake = await startFakeGhost((req, res) => {
      if (req.headers['x-forwarded-proto'] === 'https') {
        res.writeHead(200).end('ok');
      } else {
        res.writeHead(301, { Location: 'https://127.0.0.1:1/' }).end();
      }
    });
    close = fake.close;
    const probe = createHttpGhostProbe(fake.url, 1000);
    expect(await probe.isHealthy()).toBe(true);
  });

  it('is unhealthy on a 3xx -- never followed, whatever it points at', async () => {
    const fake = await startFakeGhost((_req, res) => {
      res.writeHead(301, { Location: 'https://an-entirely-different-host.example/' }).end();
    });
    close = fake.close;
    const probe = createHttpGhostProbe(fake.url, 1000);
    expect(await probe.isHealthy()).toBe(false);
  });

  it('is unhealthy on a non-200 2xx -- only exactly 200 counts as healthy', async () => {
    const fake = await startFakeGhost((_req, res) => res.writeHead(204).end());
    close = fake.close;
    const probe = createHttpGhostProbe(fake.url, 1000);
    expect(await probe.isHealthy()).toBe(false);
  });
});
