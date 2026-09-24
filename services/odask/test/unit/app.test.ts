import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { DescriptorStore } from '../../src/descriptorStore.js';
import { TokenBucket } from '../../src/rateLimiter.js';

const PLATFORM_ZONE = 'sites.publicpress.co.uk';
const OWNED_DOMAINS = ['publicpress.co.uk', 'trypublicpress.co.uk'];

let dir: string;
let server: Server;
let base: string;

function write(name: string, hostname: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify({ kind: 'tenant', hostname }));
}

async function start(rateLimiter: TokenBucket): Promise<DescriptorStore> {
  const store = new DescriptorStore({
    descriptorDir: dir,
    platformZone: PLATFORM_ZONE,
    ownedDomains: OWNED_DOMAINS,
    maxStalenessMs: 60_000,
  });
  await store.refresh();
  const app = createApp(store, rateLimiter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  return store;
}

interface Reply {
  status: number;
  body: unknown;
}

function ask(query: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/${query}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'odask-app-'));
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('createApp', () => {
  it('200s a served hostname exactly as Caddy will send it', async () => {
    write('t1.json', { kind: 'ours', sub: 'tenant-one', gated: false });
    await start(new TokenBucket(50, 10));
    const res = await ask('?domain=tenant-one.sites.publicpress.co.uk');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ domain: 'tenant-one.sites.publicpress.co.uk' });
  });

  it("200s regardless of the SNI value's case or trailing dot -- served-set membership is normalized", async () => {
    write('t1.json', { kind: 'ours', sub: 'tenant-one', gated: false });
    await start(new TokenBucket(50, 10));
    const res = await ask('?domain=Tenant-One.Sites.PublicPress.co.uk.');
    expect(res.status).toBe(200);
  });

  it('403s an unserved hostname under the ceiling', async () => {
    await start(new TokenBucket(50, 10));
    const res = await ask('?domain=evil.trypublicpress.co.uk');
    expect(res.status).toBe(403);
  });

  it('400s a missing domain parameter', async () => {
    await start(new TokenBucket(50, 10));
    const res = await ask('');
    expect(res.status).toBe(400);
  });

  it('400s an empty domain parameter', async () => {
    await start(new TokenBucket(50, 10));
    const res = await ask('?domain=');
    expect(res.status).toBe(400);
  });

  it.each(['not a hostname', '-leading-hyphen.example', 'a'.repeat(300), '../../etc/passwd'])(
    '400s a malformed domain parameter: %j',
    async (value) => {
      await start(new TokenBucket(50, 10));
      const res = await ask(`?domain=${encodeURIComponent(value)}`);
      expect(res.status).toBe(400);
    }
  );

  it('429s once the ceiling is exhausted -- a burst of unknown names is refused without growing memory', async () => {
    await start(new TokenBucket(2, 1e-6));
    expect((await ask('?domain=one.trypublicpress.co.uk')).status).toBe(403);
    expect((await ask('?domain=two.trypublicpress.co.uk')).status).toBe(403);
    expect((await ask('?domain=three.trypublicpress.co.uk')).status).toBe(429);
    expect((await ask('?domain=four.trypublicpress.co.uk')).status).toBe(429);
  });

  it('a served hostname never touches the ceiling -- only a miss costs a token', async () => {
    write('t1.json', { kind: 'ours', sub: 'tenant-one', gated: false });
    // Capacity of exactly 1: if a served-hostname request consumed a token,
    // the single unknown-hostname request below would still see it exhausted.
    await start(new TokenBucket(1, 1e-6));
    for (let i = 0; i < 5; i += 1) {
      expect((await ask('?domain=tenant-one.sites.publicpress.co.uk')).status).toBe(200);
    }
    expect((await ask('?domain=evil.trypublicpress.co.uk')).status).toBe(403);
  });

  it('disables x-powered-by', async () => {
    await start(new TokenBucket(50, 10));
    const res = await new Promise<{ headers: Record<string, string | string[] | undefined> }>(
      (resolve, reject) => {
        const req = request(`${base}/?domain=evil.trypublicpress.co.uk`, (r) => {
          r.resume();
          r.on('end', () => resolve({ headers: r.headers }));
        });
        req.on('error', reject);
        req.end();
      }
    );
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
