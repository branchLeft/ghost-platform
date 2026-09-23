import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('is unhealthy on a 3xx, even when the redirect target is reachable and healthy', async () => {
    // The target genuinely answers 200 -- the point is that fetch's default
    // redirect mode would follow it and come back healthy, so this only
    // fails when redirect: 'manual' stops the follow. A target that was
    // itself unreachable would pass this test whether or not that guard was
    // there at all.
    const target = await startFakeGhost((_req, res) => res.writeHead(200).end('ok'));
    const fake = await startFakeGhost((_req, res) => {
      res.writeHead(301, { Location: target.url }).end();
    });
    close = async () => {
      await fake.close();
      await target.close();
    };
    const probe = createHttpGhostProbe(fake.url, 1000);
    expect(await probe.isHealthy()).toBe(false);
  });

  it('is unhealthy on a non-200 2xx -- only exactly 200 counts as healthy', async () => {
    const fake = await startFakeGhost((_req, res) => res.writeHead(204).end());
    close = fake.close;
    const probe = createHttpGhostProbe(fake.url, 1000);
    expect(await probe.isHealthy()).toBe(false);
  });

  it('resolves cleanly, with no unhandled rejection, when the body errors after headers arrive', async () => {
    // A real connection reset mid-stream can't be induced deterministically
    // over a loopback socket, but its effect on cancel() can: a stream that
    // errors as soon as anything reads it makes body.cancel() reject, which
    // is exactly what a reset-after-headers response does to fetch's body.
    const erroredBody = new ReadableStream({
      start(controller) {
        controller.error(new Error('socket reset after headers'));
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(erroredBody, { status: 200 }));
    try {
      const probe = createHttpGhostProbe('http://127.0.0.1:1/', 1000);
      // The assertion is the resolution itself: an uncaught rejection from
      // cancel() would otherwise surface as an unhandled rejection outside
      // this call, not as a thrown error probe.isHealthy() could catch --
      // vitest fails the run on one, so nothing further needs to be checked.
      await expect(probe.isHealthy()).resolves.toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
