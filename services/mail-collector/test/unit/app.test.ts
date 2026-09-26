import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { DescriptorTargetStore } from '../../src/descriptorTargets.js';
import { createLogger } from '../../src/log.js';

let server: Server | undefined;

function listen(app: ReturnType<typeof createApp>): Promise<string> {
  return new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
    server.on('error', reject);
  });
}

afterEach(async () => {
  if (server) {
    await new Promise((r) => server!.close(r));
    server = undefined;
  }
});

describe('createApp', () => {
  it('healthz reports the current target count and staleness', async () => {
    const store = new DescriptorTargetStore({
      descriptorDir: '/does/not/exist',
      shimPort: 8080,
      maxStalenessMs: 60_000,
      log: createLogger(() => {}),
    });
    const baseUrl = await listen(createApp(store));
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', targetCount: 0, descriptorStale: true });
  });
});
