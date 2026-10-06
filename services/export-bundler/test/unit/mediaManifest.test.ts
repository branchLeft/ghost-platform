import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  createHttpMediaProbe,
  assertSafeObjectKey,
  ErasureDateError,
  MediaBaseError,
  parseErasureDate,
  objectUrl,
  parseMediaBase,
  planMedia,
  scanMediaReferences,
  type MediaProbe,
} from '../../src/mediaManifest.js';
import { mediaBaseUrlOf } from '../../src/tenantConfig.js';

const BASE = 'https://media.test/opaque-t1';
const NOW = 1_800_000_000;

describe('parseMediaBase', () => {
  it('splits the origin from the tenant prefix, ignoring a trailing slash', () => {
    expect(parseMediaBase(`${BASE}/`)).toEqual({
      origin: 'https://media.test',
      path: '/opaque-t1',
    });
  });

  it.each([
    'nonsense',
    'http://media.test/opaque-t1',
    'https://media.test/opaque-t1?x=1',
    'https://media.test/',
    'https://media.test',
  ])('refuses %s, so a whole shared host is never taken as one tenant', (base) => {
    expect(() => parseMediaBase(base)).toThrow(MediaBaseError);
  });
});

describe('scanMediaReferences', () => {
  it("collects the tenant's own references once each, whatever carries them", () => {
    const json = JSON.stringify({
      a: `${BASE}/2026/a.png`,
      b: `<img src="${BASE}/2026/a.png" srcset="${BASE}/2026/b.png 2x, ${BASE}/2026/c%20d.png 3x">`,
      c: `see ${BASE}/2026/e.png.`,
    });
    const scan = scanMediaReferences(json, BASE);
    expect(scan.keys).toEqual(['2026/a.png', '2026/b.png', '2026/c d.png', '2026/e.png']);
    expect(scan.refused).toEqual([]);
  });

  it("REFUSES another tenant's object on the same shard, and names it", () => {
    const scan = scanMediaReferences(
      `{"own":"${BASE}/a.png","other":"https://media.test/opaque-t2/b.png","prefixlike":"https://media.test/opaque-t1evil/c.png"}`,
      BASE
    );
    expect(scan.keys).toEqual(['a.png']);
    expect(scan.refused).toEqual([
      { reference: 'https://media.test/opaque-t2/b.png', reason: 'outside-tenant-prefix' },
      { reference: 'https://media.test/opaque-t1evil/c.png', reason: 'outside-tenant-prefix' },
    ]);
  });

  it('refuses a traversal out of the prefix, and an encoded separator, instead of linking them', () => {
    const scan = scanMediaReferences(
      `{"x":"${BASE}/%2e%2e/opaque-t2/b.png","y":"${BASE}/a%2Fb.png"}`,
      BASE
    );
    expect(scan.keys).toEqual([]);
    expect(scan.refused.map((r) => r.reason)).toEqual([
      // The URL parser has already resolved the dot segments, which lands outside the prefix.
      'outside-tenant-prefix',
      'unsafe-key',
    ]);
  });

  it('ignores links to other origins and text that only looks like a URL', () => {
    const scan = scanMediaReferences('{"x":"https://example.org/a.png","y":"https://"}', BASE);
    expect(scan).toEqual({ keys: [], refused: [] });
  });
});

describe('planMedia', () => {
  const scan = { keys: ['a.png', 'b.png', 'c.png', 'd.png'], refused: [] };

  it('lists the public address of each object that exists, and names the ones that do not or cannot be checked', async () => {
    const probe: MediaProbe = {
      async head(url) {
        if (url.endsWith('/b.png')) return { exists: false, bytes: null };
        if (url.endsWith('/c.png')) throw new Error('network down');
        return { exists: true, bytes: 12 };
      },
    };
    const plan = await planMedia(scan, BASE, probe);
    expect(plan.addresses).toEqual([
      { key: 'a.png', url: `${BASE}/a.png`, bytes: 12 },
      { key: 'd.png', url: `${BASE}/d.png`, bytes: 12 },
    ]);
    expect(plan.missing).toEqual(['b.png']);
    expect(plan.unverified).toEqual(['c.png']);
  });

  it('lists nothing for an object the probe did not find', async () => {
    const plan = await planMedia(scan, BASE, {
      head: async () => ({ exists: false, bytes: null }),
    });
    expect(plan.addresses).toEqual([]);
    expect(plan.missing).toHaveLength(4);
  });

  it('encodes keys when it builds the address it probes', () => {
    expect(objectUrl(BASE, '2026/a b.png')).toBe('https://media.test/opaque-t1/2026/a%20b.png');
  });
});

describe('parseErasureDate', () => {
  it('accepts a real future calendar day', () => {
    expect(parseErasureDate('2030-02-28', NOW)).toBe('2030-02-28');
  });

  it.each(['2030-02-30', '2030-2-3', 'soon', '', '2030-02-28T00:00:00Z'])('refuses %j', (v) => {
    expect(() => parseErasureDate(v, NOW)).toThrow(ErasureDateError);
  });

  it('refuses today and the past, because addresses listed past that day would be a lie', () => {
    expect(() => parseErasureDate('2027-01-15', NOW)).toThrow(/future/);
    expect(() => parseErasureDate('2020-01-01', NOW)).toThrow(/future/);
  });
});

describe('assertSafeObjectKey', () => {
  it.each([
    '',
    '/a',
    'a//b',
    'a/./b',
    'a/../b',
    '..',
    'a\\b',
    'a%2Fb',
    'a/%2e%2E/b',
    'a\u0000b',
    'a?b',
    'a#b',
    'x'.repeat(1025),
  ])('refuses %j', (key) => {
    expect(() => assertSafeObjectKey(key)).toThrow(MediaBaseError);
  });

  it('accepts an ordinary object key', () => {
    expect(() => assertSafeObjectKey('2026/10/photo-1.png')).not.toThrow();
  });
});

describe('createHttpMediaProbe', () => {
  async function serve(status: number, headers: Record<string, string> = {}) {
    const server = createServer((_req, res) => {
      res.writeHead(status, headers);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
    return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('reads existence and size from a HEAD', async () => {
    const s = await serve(200, { 'content-length': '42' });
    try {
      expect(await createHttpMediaProbe(2000).head(s.url)).toEqual({ exists: true, bytes: 42 });
    } finally {
      await s.close();
    }
  });

  it('reads 404 and 403 as absent, and anything else as a failure to check', async () => {
    for (const status of [404, 403]) {
      const s = await serve(status);
      try {
        expect((await createHttpMediaProbe(2000).head(s.url)).exists).toBe(false);
      } finally {
        await s.close();
      }
    }
    const s = await serve(500);
    try {
      await expect(createHttpMediaProbe(2000).head(s.url)).rejects.toThrow(/500/);
    } finally {
      await s.close();
    }
  });
});

describe('scope from the rendered shard shape', () => {
  const shard = (prefix: string) => ({
    storage__images__cdnUrl: 'https://media.example',
    storage__images__tenantPrefix: prefix,
  });

  it('on a shared shard, links only the tenant whose prefix it is, and refuses a neighbour', () => {
    const own = mediaBaseUrlOf(shard('opaque-t1'))!;
    const content = JSON.stringify({
      a: 'https://media.example/opaque-t1/content/images/2026/a.png',
      b: 'https://media.example/opaque-t2/content/images/2026/b.png',
    });
    const scan = scanMediaReferences(content, own);
    expect(scan.keys).toEqual(['content/images/2026/a.png']);
    expect(scan.refused).toEqual([
      {
        reference: 'https://media.example/opaque-t2/content/images/2026/b.png',
        reason: 'outside-tenant-prefix',
      },
    ]);
    // The same content seen from the neighbour links the other object only.
    expect(scanMediaReferences(content, mediaBaseUrlOf(shard('opaque-t2'))!).keys).toEqual([
      'content/images/2026/b.png',
    ]);
  });

  it('fails closed for a bare media address with no prefix, rather than admitting the whole shard', () => {
    const base = mediaBaseUrlOf({ storage__images__cdnUrl: 'https://media.example' })!;
    expect(() => scanMediaReferences('{}', base)).toThrow(MediaBaseError);
  });
});
