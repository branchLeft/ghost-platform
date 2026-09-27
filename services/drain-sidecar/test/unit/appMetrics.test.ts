import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { DrainFlag } from '../../src/drainFlag.js';
import type { GhostProbe } from '../../src/ghostProbe.js';
import type { GhostVersionProbe } from '../../src/versionProbe.js';

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

const unusedHealth: GhostProbe = {
  isHealthy: async () => {
    throw new Error('/metrics must never call the health probe');
  },
};

/**
 * These exercise the real Express route in `app.ts`, not just
 * `deriveVersionState()` in isolation -- the wiring itself (does the route
 * actually gate the probe call on the flag, and pass the flag's live
 * result into the derive function on every request) is the thing worth
 * proving through the real entry point, per the estate's standing rule
 * that a control proven only in its own module doesn't prove the running
 * service uses it.
 */
describe('createApp() — GET /metrics, through the real route', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('undrained, matching: reports the version and a positive match', async () => {
    const version: GhostVersionProbe = { getVersion: async () => '6.55.0' };
    const listening = await listen(createApp(fakeFlag(false), unusedHealth, version, '6.55.0'));
    close = listening.close;

    const res = await fetch(`${listening.baseUrl}/metrics`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('drain_sidecar_drained 0');
    expect(body).toContain('drain_sidecar_ghost_version_info{version="6.55.0"} 1');
    expect(body).toContain('drain_sidecar_version_match 1');
  });

  it('undrained, reverted: reports the version and a real mismatch', async () => {
    const version: GhostVersionProbe = { getVersion: async () => '6.55.0' };
    const listening = await listen(createApp(fakeFlag(false), unusedHealth, version, '6.56.0'));
    close = listening.close;

    const body = await (await fetch(`${listening.baseUrl}/metrics`)).text();
    expect(body).toContain('drain_sidecar_version_match 0');
  });

  it('drained: never calls the version probe at all, and neither version gauge appears', async () => {
    let called = false;
    const version: GhostVersionProbe = {
      getVersion: async () => {
        called = true;
        return '6.55.0';
      },
    };
    const listening = await listen(createApp(fakeFlag(true), unusedHealth, version, '6.56.0'));
    close = listening.close;

    const res = await fetch(`${listening.baseUrl}/metrics`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(called).toBe(false);
    expect(body).toContain('drain_sidecar_drained 1');
    expect(body).not.toContain('drain_sidecar_ghost_version_info');
    expect(body).not.toContain('drain_sidecar_version_match');
  });
});
