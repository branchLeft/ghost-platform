import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { DrainFlag } from '../../src/drainFlag.js';
import type { GhostProbe } from '../../src/ghostProbe.js';

interface Listening {
  baseUrl: string;
  close: () => Promise<void>;
}

function listen(app: ReturnType<typeof createApp>): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}

function fakeFlag(isSet: boolean): DrainFlag {
  return { isSet: () => isSet };
}

function fakeGhost(healthy: boolean): GhostProbe {
  return { isHealthy: async () => healthy };
}

describe('createApp — GET /healthz', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('answers 503 when the flag is set, without even asking Ghost', async () => {
    let asked = false;
    const ghost: GhostProbe = {
      isHealthy: async () => {
        asked = true;
        return true;
      },
    };
    const listening = await listen(createApp(fakeFlag(true), ghost));
    close = listening.close;

    const res = await fetch(`${listening.baseUrl}/healthz`);
    expect(res.status).toBe(503);
    expect(asked).toBe(false);
  });

  it('answers 200 when the flag is clear and Ghost is healthy', async () => {
    const listening = await listen(createApp(fakeFlag(false), fakeGhost(true)));
    close = listening.close;

    const res = await fetch(`${listening.baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it('answers 503 when the flag is clear but Ghost is unhealthy -- the flag alone is not enough to pass', async () => {
    const listening = await listen(createApp(fakeFlag(false), fakeGhost(false)));
    close = listening.close;

    const res = await fetch(`${listening.baseUrl}/healthz`);
    expect(res.status).toBe(503);
  });

  it('answers 503 when the flag is set even though Ghost is unhealthy too -- same verdict, not a coincidence of the other check', async () => {
    const listening = await listen(createApp(fakeFlag(true), fakeGhost(false)));
    close = listening.close;

    const res = await fetch(`${listening.baseUrl}/healthz`);
    expect(res.status).toBe(503);
  });

  it('disables the X-Powered-By header', async () => {
    const listening = await listen(createApp(fakeFlag(false), fakeGhost(true)));
    close = listening.close;

    const res = await fetch(`${listening.baseUrl}/healthz`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
