import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpGhostVersionProbe } from '../../src/versionProbe.js';

interface Listening {
  url: string;
  close: () => Promise<void>;
}

function serve(handler: (app: express.Express) => void): Promise<Listening> {
  const app = express();
  handler(app);
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}

describe('createHttpGhostVersionProbe()', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('reads the version out of a real, unauthenticated site-info response', async () => {
    const listening = await serve((app) => {
      app.get('/', (_req, res) => res.status(200).json({ site: { version: '6.55.0' } }));
    });
    close = listening.close;

    const version = await createHttpGhostVersionProbe(listening.url, 2000).getVersion();
    expect(version).toBe('6.55.0');
  });

  it('is null, never a throw, on a non-200 status', async () => {
    const listening = await serve((app) => {
      app.get('/', (_req, res) => res.status(500).json({}));
    });
    close = listening.close;

    const version = await createHttpGhostVersionProbe(listening.url, 2000).getVersion();
    expect(version).toBeNull();
  });

  it('is null on a malformed body -- present, but not the shape expected', async () => {
    const listening = await serve((app) => {
      app.get('/', (_req, res) => res.status(200).json({ nothing: 'to see here' }));
    });
    close = listening.close;

    const version = await createHttpGhostVersionProbe(listening.url, 2000).getVersion();
    expect(version).toBeNull();
  });

  it('is null on a connection failure, not a rejection', async () => {
    // Nothing is listening on this port; a probe against a genuinely dead
    // address exercises the real fetch failure path, not a stub of it.
    const version = await createHttpGhostVersionProbe('http://127.0.0.1:1/', 200).getVersion();
    expect(version).toBeNull();
  });

  it('is null on a redirect -- never followed, per the same-origin contract createHttpGhostProbe already carries', async () => {
    const listening = await serve((app) => {
      app.get('/', (_req, res) => res.redirect(302, 'http://127.0.0.1:1/ghost/api/admin/site/'));
    });
    close = listening.close;

    const version = await createHttpGhostVersionProbe(listening.url, 2000).getVersion();
    expect(version).toBeNull();
  });
});
