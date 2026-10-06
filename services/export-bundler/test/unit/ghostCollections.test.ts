import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpGhostExportClient, GhostExportError } from '../../src/ghostExportClient.js';

const COOKIE = 'ghost-admin-api-session=s%3Afake';
let server: Server | undefined;
const seen: string[] = [];

async function listen(
  handler: (url: URL) => { status?: number; body: string; type?: string } | undefined
): Promise<string> {
  seen.length = 0;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/ghost/') {
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}; Path=/ghost` });
      res.end();
      return;
    }
    seen.push(`${url.pathname}${url.search}`);
    const out = handler(url);
    res.writeHead(out?.status ?? 404, { 'content-type': out?.type ?? 'application/json' });
    res.end(out?.body ?? '');
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const tokens = { obtain: async () => 'tok' };

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('paged collections', () => {
  it("reads every page of members until Ghost says there are no more, and returns Ghost's own total", async () => {
    const base = await listen((url) => {
      if (url.pathname !== '/ghost/api/admin/members/') return undefined;
      const page = Number(url.searchParams.get('page'));
      return {
        status: 200,
        body: JSON.stringify({
          members: [{ id: `m${page}a` }, { id: `m${page}b` }],
          meta: { pagination: { total: 5, pages: 3, page } },
        }),
      };
    });
    const result = await createHttpGhostExportClient(tokens, 3000).fetchMembers(base);
    expect(result.total).toBe(5);
    expect(result.items.map((m) => m.id)).toEqual(['m1a', 'm1b', 'm2a', 'm2b', 'm3a', 'm3b']);
    expect(seen).toEqual([
      '/ghost/api/admin/members/?include=tiers&limit=100&page=1',
      '/ghost/api/admin/members/?include=tiers&limit=100&page=2',
      '/ghost/api/admin/members/?include=tiers&limit=100&page=3',
    ]);
  });

  it('reads comments with replies included, oldest first', async () => {
    const base = await listen(() => ({
      status: 200,
      body: JSON.stringify({
        comments: [{ id: 'c1' }],
        meta: { pagination: { total: 1, pages: 1 } },
      }),
    }));
    const result = await createHttpGhostExportClient(tokens, 3000).fetchComments(base);
    expect(result).toEqual({ items: [{ id: 'c1' }], total: 1 });
    expect(seen[0]).toBe(
      '/ghost/api/admin/comments/?include_nested=true&order=created_at%20asc&limit=100&page=1'
    );
  });

  it('reads the reporters of one comment from the comment_reports list, encoding the id', async () => {
    const base = await listen(() => ({
      status: 200,
      body: JSON.stringify({
        comment_reports: [{ id: 'r1' }],
        meta: { pagination: { total: 1, pages: 1 } },
      }),
    }));
    const result = await createHttpGhostExportClient(tokens, 3000).fetchCommentReports(base, 'a/b');
    expect(result.items).toEqual([{ id: 'r1' }]);
    expect(seen[0]).toBe('/ghost/api/admin/comments/a%2Fb/reports/?limit=100&page=1');
  });

  it("fetches the member CSV from Ghost's own export route", async () => {
    const base = await listen((url) =>
      url.pathname === '/ghost/api/admin/members/upload/'
        ? { status: 200, type: 'text/csv', body: 'id,email\n' }
        : undefined
    );
    const file = await createHttpGhostExportClient(tokens, 3000).fetchMembersCsv(base);
    expect(file.body.toString()).toBe('id,email\n');
    expect(seen[0]).toBe('/ghost/api/admin/members/upload/?limit=all');
  });

  it.each([
    ['not JSON', 'nope'],
    ['no list', JSON.stringify({ meta: { pagination: { total: 1, pages: 1 } } })],
    ['no total', JSON.stringify({ members: [], meta: { pagination: { pages: 1 } } })],
    ['no pagination', JSON.stringify({ members: [] })],
  ])('REFUSES a response with %s, so a count is never invented', async (_l, body) => {
    const base = await listen(() => ({ status: 200, body }));
    await expect(createHttpGhostExportClient(tokens, 3000).fetchMembers(base)).rejects.toThrow(
      GhostExportError
    );
  });

  it('fails on a non-200 page', async () => {
    const base = await listen(() => ({ status: 500, body: '{}' }));
    await expect(createHttpGhostExportClient(tokens, 3000).fetchComments(base)).rejects.toThrow(
      /500/
    );
  });
});
