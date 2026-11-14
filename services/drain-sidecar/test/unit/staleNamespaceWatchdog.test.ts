import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpReachabilityProbe,
  createStaleNamespaceWatch,
  type ReachabilityProbe,
} from '../../src/staleNamespaceWatchdog.js';

function scripted(results: boolean[]): ReachabilityProbe {
  let index = 0;
  return {
    async isReachable() {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result === true;
    },
  };
}

describe('createStaleNamespaceWatch', () => {
  it('reports stale once Ghost has been unreachable for the whole window', async () => {
    let now = 0;
    const watch = createStaleNamespaceWatch({
      probe: scripted([false]),
      staleAfterMs: 5000,
      now: () => now,
    });
    expect(await watch.check()).toBe(false);
    now = 4999;
    expect(await watch.check()).toBe(false);
    now = 5000;
    expect(await watch.check()).toBe(true);
  });

  it('starts the window again after any answer from Ghost', async () => {
    let now = 0;
    const watch = createStaleNamespaceWatch({
      probe: scripted([false, false, true, false, false]),
      staleAfterMs: 5000,
      now: () => now,
    });
    expect(await watch.check()).toBe(false); // unreachable since 0
    now = 4000;
    expect(await watch.check()).toBe(false); // unreachable since 0, 4000 elapsed
    now = 4500;
    expect(await watch.check()).toBe(false); // reachable: window cleared
    now = 6000;
    expect(await watch.check()).toBe(false); // unreachable since 6000
    now = 10999;
    expect(await watch.check()).toBe(false); // 4999 elapsed
  });

  it('never reports stale while Ghost keeps answering', async () => {
    let now = 0;
    const watch = createStaleNamespaceWatch({
      probe: scripted([true]),
      staleAfterMs: 1000,
      now: () => now,
    });
    for (now = 0; now < 100_000; now += 1000) {
      expect(await watch.check()).toBe(false);
    }
  });
});

describe('createHttpReachabilityProbe', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  function listen(status: number): Promise<string> {
    return new Promise((resolve) => {
      server = createServer((_req, res) => res.writeHead(status).end());
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/`);
      });
    });
  }

  it('counts any HTTP answer as reachable, an error status included', async () => {
    const url = await listen(500);
    expect(await createHttpReachabilityProbe(url, 1000).isReachable()).toBe(true);
  });

  it('counts a refused connection as unreachable', async () => {
    const url = await listen(200);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    expect(await createHttpReachabilityProbe(url, 1000).isReachable()).toBe(false);
  });
});
