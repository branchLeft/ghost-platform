import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpGhostProbe, waitUntilHealthy } from '../../src/ghostProbe.js';

function listen(status: number): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      expect(req.headers['x-forwarded-proto']).toBe('https');
      res.writeHead(status);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(() => r())),
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

  it('is healthy only on exactly 200', async () => {
    const listening = await listen(200);
    close = listening.close;
    expect(await createHttpGhostProbe(2000).isHealthy(listening.baseUrl)).toBe(true);
  });

  it('is not healthy on a non-200', async () => {
    const listening = await listen(503);
    close = listening.close;
    expect(await createHttpGhostProbe(2000).isHealthy(listening.baseUrl)).toBe(false);
  });

  it('is not healthy when nothing is listening', async () => {
    expect(await createHttpGhostProbe(500).isHealthy('http://127.0.0.1:1')).toBe(false);
  });

  it('is not healthy when the request genuinely times out -- the abort timer actually fires, not just the catch branch', async () => {
    const server = createServer(() => {
      /* never responds -- holds the connection open past the timeout */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    try {
      const healthy = await createHttpGhostProbe(50).isHealthy(`http://127.0.0.1:${address.port}`);
      expect(healthy).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('waitUntilHealthy', () => {
  it('resolves true as soon as the probe reports healthy', async () => {
    let calls = 0;
    const probe = { isHealthy: async () => (calls++ >= 2 ? true : false) };
    const sleeps: number[] = [];
    const result = await waitUntilHealthy(probe, 'http://x', 10_000, 10, async (ms) => {
      sleeps.push(ms);
    });
    expect(result).toBe(true);
    expect(calls).toBe(3);
  });

  it('resolves false once the deadline passes, without hanging', async () => {
    const probe = { isHealthy: async () => false };
    const started = Date.now();
    const result = await waitUntilHealthy(probe, 'http://x', 100, 20);
    expect(result).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});
