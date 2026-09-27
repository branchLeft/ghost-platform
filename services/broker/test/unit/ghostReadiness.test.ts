import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpGhostReadinessChecker, waitUntilReady } from '../../src/ghostReadiness.js';

interface FakeGhost {
  port: number;
  close: () => Promise<void>;
}

function startFakeGhost(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<FakeGhost> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
    server.on('error', reject);
  });
}

describe('createHttpGhostReadinessChecker', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('is ready on exactly 200', async () => {
    const fake = await startFakeGhost((_req, res) => res.writeHead(200).end('ok'));
    close = fake.close;
    const checker = createHttpGhostReadinessChecker('127.0.0.1', 1000);
    expect(await checker.isReady(fake.port)).toBe(true);
  });

  it('is not ready on a non-200 -- Ghost boots in a maintenance mode that answers 503', async () => {
    const fake = await startFakeGhost((_req, res) => res.writeHead(503).end());
    close = fake.close;
    const checker = createHttpGhostReadinessChecker('127.0.0.1', 1000);
    expect(await checker.isReady(fake.port)).toBe(false);
  });

  it('is not ready, not throwing, when nothing is listening on the port', async () => {
    const checker = createHttpGhostReadinessChecker('127.0.0.1', 500);
    expect(await checker.isReady(1)).toBe(false);
  });

  it('is not ready on a timeout rather than hanging the caller', async () => {
    const fake = await startFakeGhost(() => {
      /* deliberately never responds */
    });
    close = fake.close;
    const checker = createHttpGhostReadinessChecker('127.0.0.1', 100);
    const start = Date.now();
    expect(await checker.isReady(fake.port)).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('sends X-Forwarded-Proto: https, matching every real request the edge sends', async () => {
    const fake = await startFakeGhost((req, res) => {
      if (req.headers['x-forwarded-proto'] === 'https') {
        res.writeHead(200).end('ok');
      } else {
        res.writeHead(301, { Location: 'https://127.0.0.1:1/' }).end();
      }
    });
    close = fake.close;
    const checker = createHttpGhostReadinessChecker('127.0.0.1', 1000);
    expect(await checker.isReady(fake.port)).toBe(true);
  });

  it('never follows a 3xx -- a redirect is not read as ready even when its target is healthy', async () => {
    const target = await startFakeGhost((_req, res) => res.writeHead(200).end('ok'));
    const fake = await startFakeGhost((_req, res) => {
      res.writeHead(301, { Location: `http://127.0.0.1:${target.port}/` }).end();
    });
    close = async () => {
      await fake.close();
      await target.close();
    };
    const checker = createHttpGhostReadinessChecker('127.0.0.1', 1000);
    expect(await checker.isReady(fake.port)).toBe(false);
  });
});

describe('waitUntilReady', () => {
  it('returns true as soon as the checker reports ready', async () => {
    let calls = 0;
    const checker = { isReady: async () => (calls++ === 0 ? false : true) };
    const sleeps: number[] = [];
    const ready = await waitUntilReady(checker, 1, 5000, 10, async (ms) => {
      sleeps.push(ms);
    });
    expect(ready).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([10]);
  });

  it('returns false once the deadline passes, without polling forever', async () => {
    const checker = { isReady: async () => false };
    let now = 0;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const ready = await waitUntilReady(checker, 1, 30, 10, async () => {
        now += 10;
      });
      expect(ready).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });
});
