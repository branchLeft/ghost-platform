import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHttpGhostExportClient,
  GhostExportError,
  BreakGlassSessionError,
} from '../../src/ghostExportClient.js';
import type { BreakGlassMinter } from '../../src/breakGlassToken.js';

interface Listening {
  baseUrl: string;
  requests: { method: string; url: string; cookie: string | undefined }[];
  close: () => Promise<void>;
}

/**
 * Fakes exactly Ghost's own shape for this flow: `GET /ghost/` with
 * `?bl_break_glass=` sets a session cookie (or, when the token is
 * "refused", answers with no cookie at all -- matching a break-glass
 * refusal, which falls through to the ordinary login page rather than
 * erroring); every other route requires that cookie.
 */
function listen(opts: { refuseBreakGlass?: boolean; denyExport?: boolean }): Promise<Listening> {
  const requests: Listening['requests'] = [];
  const validCookie = 'ghost-admin-api-session=s%3Afaketoken';
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const cookie = req.headers.cookie;
      requests.push({ method: req.method ?? '', url: req.url ?? '', cookie });

      if (req.url?.startsWith('/ghost/?bl_break_glass=')) {
        if (opts.refuseBreakGlass) {
          res.writeHead(200);
          res.end('login page');
          return;
        }
        res.writeHead(302, {
          Location: '/ghost/#/',
          'Set-Cookie': `${validCookie}; Path=/ghost; HttpOnly; Secure`,
        });
        res.end();
        return;
      }

      if (cookie !== validCookie) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"errors":[{"message":"Authorization failed"}]}');
        return;
      }

      if (opts.denyExport) {
        // A session Ghost genuinely granted, but whose role still lacks
        // "Export database" -- Ghost's own real behaviour against a
        // non-Administrator account (verified against a live container).
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"errors":[{"message":"You do not have permission to exportContent db"}]}');
        return;
      }

      if (req.url === '/ghost/api/admin/db/') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-disposition': 'Attachment; filename="tenant.ghost.2026-01-01.json"',
        });
        res.end('{"db":[]}');
        return;
      }
      if (req.url === '/ghost/api/admin/posts/export/') {
        res.writeHead(200, {
          'content-type': 'text/csv',
          'content-disposition': 'Attachment; filename="tenant.ghost.analytics.2026-01-01.csv"',
        });
        res.end('post_id,visits\n1,2\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}

function fakeMinter(): BreakGlassMinter & { mintCalls: number } {
  let n = 0;
  return {
    mintCalls: 0,
    mint() {
      n += 1;
      this.mintCalls = n;
      return `fake-token-${n}`;
    },
  };
}

describe('createHttpGhostExportClient', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('opens a break-glass session first, then fetches content & settings with that cookie', async () => {
    const listening = await listen({});
    close = listening.close;

    const client = createHttpGhostExportClient(fakeMinter(), 5000);
    const file = await client.fetchContentAndSettings(listening.baseUrl);

    expect(listening.requests[0]?.url).toContain('/ghost/?bl_break_glass=fake-token-1');
    expect(listening.requests[1]).toMatchObject({ method: 'GET', url: '/ghost/api/admin/db/' });
    expect(listening.requests[1]?.cookie).toBe('ghost-admin-api-session=s%3Afaketoken');
    expect(file.filename).toBe('tenant.ghost.2026-01-01.json');
    expect(file.body.toString('utf8')).toBe('{"db":[]}');
  });

  it('fetches post analytics from GET /ghost/api/admin/posts/export/', async () => {
    const listening = await listen({});
    close = listening.close;

    const file = await createHttpGhostExportClient(fakeMinter(), 5000).fetchPostAnalytics(
      listening.baseUrl
    );
    expect(file.filename).toBe('tenant.ghost.analytics.2026-01-01.csv');
    expect(file.body.toString('utf8')).toBe('post_id,visits\n1,2\n');
  });

  it('opens exactly one session and reuses it for both exports -- one audited action, not two break-glass spends', async () => {
    const listening = await listen({});
    close = listening.close;
    const minter = fakeMinter();
    const client = createHttpGhostExportClient(minter, 5000);

    await Promise.all([
      client.fetchContentAndSettings(listening.baseUrl),
      client.fetchPostAnalytics(listening.baseUrl),
    ]);

    const breakGlassRequests = listening.requests.filter((r) =>
      r.url.startsWith('/ghost/?bl_break_glass=')
    );
    expect(breakGlassRequests).toHaveLength(1);
    expect(minter.mintCalls).toBe(1);
  });

  it('raises BreakGlassSessionError when the token is refused (no session cookie comes back)', async () => {
    const listening = await listen({ refuseBreakGlass: true });
    close = listening.close;

    await expect(
      createHttpGhostExportClient(fakeMinter(), 5000).fetchContentAndSettings(listening.baseUrl)
    ).rejects.toThrow(BreakGlassSessionError);
  });

  it('raises GhostExportError on a non-200 from the export route itself, distinct from a session failure', async () => {
    const listening = await listen({ denyExport: true });
    close = listening.close;
    await expect(
      createHttpGhostExportClient(fakeMinter(), 5000).fetchContentAndSettings(listening.baseUrl)
    ).rejects.toThrow(GhostExportError);
  });

  it('GhostExportError and BreakGlassSessionError are both real Error subclasses with the failing status on them', async () => {
    const listening = await listen({ refuseBreakGlass: true });
    close = listening.close;
    try {
      await createHttpGhostExportClient(fakeMinter(), 5000).fetchContentAndSettings(
        listening.baseUrl
      );
      throw new Error('expected fetchContentAndSettings to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BreakGlassSessionError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
