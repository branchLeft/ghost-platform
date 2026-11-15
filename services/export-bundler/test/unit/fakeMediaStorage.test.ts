import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeMediaStorageHandler } from '../helpers/fakeMediaStorage.js';
import { createHttpMediaProbe } from '../../src/mediaManifest.js';

let server: Server | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function start(answer500: readonly string[]): Promise<{ base: string; log: string[] }> {
  const log: string[] = [];
  const handler = createFakeMediaStorageHandler({
    prefix: '/media-proof',
    objects: { 'content/images/a.png': 12, 'content/media/b file.mp4': 34 },
    answer500,
    onRequest: (line) => log.push(line),
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(port)}/media-proof`, log };
}

describe('the fake media storage', () => {
  it('answers 200 with the size for an object that exists and 404 for one that does not', async () => {
    const { base, log } = await start([]);
    const probe = createHttpMediaProbe(5000);
    await expect(probe.head(`${base}/content/images/a.png`)).resolves.toEqual({
      exists: true,
      bytes: 12,
    });
    await expect(probe.head(`${base}/content/media/b%20file.mp4`)).resolves.toEqual({
      exists: true,
      bytes: 34,
    });
    await expect(probe.head(`${base}/content/images/none.png`)).resolves.toEqual({
      exists: false,
      bytes: null,
    });
    expect(log).toEqual([
      'HEAD /media-proof/content/images/a.png 200',
      'HEAD /media-proof/content/media/b%20file.mp4 200',
      'HEAD /media-proof/content/images/none.png 404',
    ]);
  });

  it('answers 500 for a key on the sabotage list, which the bundler probe cannot read as present or missing', async () => {
    const { base } = await start(['content/media/b file.mp4']);
    const probe = createHttpMediaProbe(5000);
    await expect(probe.head(`${base}/content/media/b%20file.mp4`)).rejects.toThrow(/500/);
    await expect(probe.head(`${base}/content/images/a.png`)).resolves.toMatchObject({
      exists: true,
    });
  });

  it('refuses a method the bundler never sends and anything outside the tenant prefix', async () => {
    const { base } = await start([]);
    const post = await fetch(`${base}/content/images/a.png`, { method: 'POST' });
    expect(post.status).toBe(405);
    const outside = await fetch(base.replace('/media-proof', '/other/content/images/a.png'), {
      method: 'HEAD',
    });
    expect(outside.status).toBe(404);
  });
});
