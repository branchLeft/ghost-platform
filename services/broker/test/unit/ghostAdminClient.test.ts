import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName, TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { adminApiConfigFromEnv } from '../../src/config.js';
import {
  AdminAccessLostError,
  createGhostAdminClient,
  OWNER_NAME_PLACEHOLDER,
  SITE_TITLE_PLACEHOLDER,
} from '../../src/ghostAdmin/client.js';
import { createAdminKeyStore, isAdminApiKey } from '../../src/ghostAdmin/keyStore.js';
import { loopbackGhostTransport } from '../../src/ghostAdmin/request.js';
import { adminApiToken } from '../../src/ghostAdmin/token.js';
import { demoDescriptor, TEST_ZONES } from '../helpers/fixtures.js';
import { startFakeGhost, type FakeGhost } from '../helpers/fakeGhost.js';

const SLOT = '0' as SlotName;
const PASSWORD = 'p'.repeat(43);

function managed(): TenantDescriptor {
  return {
    ...demoDescriptor(),
    codeInjection: { kind: 'managed', head: '<!-- H -->', foot: '<!-- F -->' },
  } as TenantDescriptor;
}

describe('the Ghost admin client', () => {
  let ghost: FakeGhost;
  let keyDir: string;

  beforeEach(async () => {
    ghost = await startFakeGhost();
    keyDir = join(await makeTempDir('broker-admin-keys-'), 'admin-keys');
  });
  afterEach(async () => {
    await ghost.close();
  });

  function client(overrides: Partial<Parameters<typeof createGhostAdminClient>[0]> = {}) {
    return createGhostAdminClient({
      keyStore: createAdminKeyStore(keyDir),
      zones: TEST_ZONES,
      readyTimeoutMs: 5_000,
      sleep: async () => undefined,
      newPassword: () => PASSWORD,
      ...overrides,
    });
  }
  const baseUrl = () => `http://127.0.0.1:${ghost.port}`;

  describe('first build', () => {
    it('creates the owner, stores only the staff token, private, and applies all three settings', async () => {
      const descriptor = demoDescriptor();
      await client().configure(baseUrl(), descriptor, SLOT);

      expect(ghost.setupBody).toEqual({
        name: OWNER_NAME_PLACEHOLDER,
        email: descriptor.ownerEmail,
        password: PASSWORD,
        blogTitle: SITE_TITLE_PLACEHOLDER,
      });
      const path = join(keyDir, '0', 'ghost-admin-key');
      expect((await readFile(path, 'utf8')).trim()).toBe(ghost.staffKey());
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(keyDir, '0'))).mode & 0o777).toBe(0o700);
      expect((await stat(keyDir)).mode & 0o777).toBe(0o700);
      expect(await readdir(join(keyDir, '0'))).toEqual(['ghost-admin-key']);
      expect(await readFile(path, 'utf8')).not.toContain(PASSWORD);

      expect(ghost.settings.get('codeinjection_head')).toBeNull();
      expect(ghost.settings.get('codeinjection_foot')).toBeNull();
      expect(ghost.settings.get('members_support_address')).toBe(
        `demo-1@${TEST_ZONES.demoMailDomain}`
      );
      expect(ghost.sessionsOpen()).toBe(0);
    });

    it('addresses Ghost as the site itself over loopback, and signs in with an Origin', async () => {
      await client().configure(baseUrl(), demoDescriptor(), SLOT);
      const host = new URL(demoDescriptor().siteUrl).host;
      for (const r of ghost.requests) {
        expect(r.headers.host).toBe(host);
        expect(r.headers['x-forwarded-proto']).toBe('https');
      }
      const signIn = ghost.requests.find((r) => r.method === 'POST' && r.path === '/session/');
      expect(signIn?.headers.origin).toBe(`https://${host}`);
      const put = ghost.requests.find((r) => r.method === 'PUT');
      expect(put?.headers.cookie).toBeUndefined();
      expect(put?.headers.authorization).toMatch(/^Ghost /);
    });

    it('uses a fresh high-entropy password by default', async () => {
      await client({ newPassword: undefined }).configure(baseUrl(), demoDescriptor(), SLOT);
      const used = String(ghost.setupBody?.password);
      expect(used).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(used).not.toBe(PASSWORD);
    });

    it('drops a key left by an earlier tenancy before storing the new one', async () => {
      const store = createAdminKeyStore(keyDir);
      await store.write('0', `${'b'.repeat(24)}:${'c'.repeat(64)}`);
      await client().configure(baseUrl(), demoDescriptor(), SLOT);
      expect(await store.read('0')).toBe(ghost.staffKey());
    });

    it("a fresh site drops the earlier tenancy's key even when the new build then fails", async () => {
      const store = createAdminKeyStore(keyDir);
      await store.write('0', `${'b'.repeat(24)}:${'c'.repeat(64)}`);
      ghost.overrides.set('POST /authentication/setup/', { status: 500 });
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        'Ghost refused site setup: 500'
      );
      expect(await store.read('0')).toBeNull();
    });

    it('waits out Ghost booting before it starts', async () => {
      ghost.bootPolls = 3;
      await client().configure(baseUrl(), demoDescriptor(), SLOT);
      expect(ghost.isSetUp()).toBe(true);
    });

    it('gives up with a clear error when Ghost never answers', async () => {
      ghost.bootPolls = 1_000;
      let now = 0;
      const c = client({
        readyTimeoutMs: 1_000,
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      await expect(c.configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        /did not answer within 1000ms \(last: 503 \(Site is starting up\)\)/
      );
    });

    it('gives up when nothing listens at all', async () => {
      await ghost.close();
      ghost = await startFakeGhost();
      let now = 0;
      const c = client({
        readyTimeoutMs: 600,
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      await expect(c.configure('http://127.0.0.1:1', demoDescriptor(), SLOT)).rejects.toThrow(
        /did not answer within 600ms \(last: .*ECONNREFUSED/
      );
    });

    it.each([
      ['POST /authentication/setup/', 'site setup'],
      ['POST /session/', 'the first sign-in'],
      ['GET /users/me/', 'reading the owner'],
      [`GET /users/${'a'.repeat(24)}/token/`, "reading the owner's staff access token"],
    ])('refuses, storing nothing, when %s fails', async (route, step) => {
      ghost.overrides.set(route, { status: 403, body: { errors: [{ message: 'nope' }] } });
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        `Ghost refused ${step}: 403 (nope)`
      );
      expect(await createAdminKeyStore(keyDir).read('0')).toBeNull();
    });

    it('refuses when the sign-in sets no session cookie', async () => {
      ghost.overrides.set('POST /session/', { status: 201, body: 'Created' });
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        'Ghost set no admin session cookie'
      );
    });

    it('refuses an owner record with no id, and still signs out', async () => {
      ghost.overrides.set('GET /users/me/', { status: 200, body: { users: [{}] } });
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        'Ghost returned no owner id'
      );
      expect(ghost.sessionsOpen()).toBe(0);
    });

    it('refuses a token response that is not a usable key', async () => {
      ghost.overrides.set(`GET /users/${'a'.repeat(24)}/token/`, {
        status: 200,
        body: { apiKey: { id: 'x', secret: 'y' } },
      });
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        'Ghost returned no usable staff access token'
      );
      expect(await createAdminKeyStore(keyDir).read('0')).toBeNull();
    });
  });

  describe('a later configure (a colour swap or a retry)', () => {
    beforeEach(async () => {
      await client().configure(baseUrl(), demoDescriptor(), SLOT);
      ghost.requests.length = 0;
    });

    it('re-applies all three settings with the stored token, never touching setup or a session', async () => {
      ghost.settings.set('codeinjection_head', '<script>prospect()</script>');
      ghost.settings.set('codeinjection_foot', '<script>prospect()</script>');
      ghost.settings.set('members_support_address', 'someone@else.example');
      await client().configure(baseUrl(), demoDescriptor(), SLOT);

      expect(ghost.settings.get('codeinjection_head')).toBeNull();
      expect(ghost.settings.get('codeinjection_foot')).toBeNull();
      expect(ghost.settings.get('members_support_address')).toBe(
        `demo-1@${TEST_ZONES.demoMailDomain}`
      );
      expect(ghost.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /authentication/setup/',
        'PUT /settings/',
      ]);
    });

    it('applies managed code injection verbatim', async () => {
      await client().configure(baseUrl(), managed(), SLOT);
      expect(ghost.settings.get('codeinjection_head')).toBe('<!-- H -->');
      expect(ghost.settings.get('codeinjection_foot')).toBe('<!-- F -->');
    });

    it('fails safe when the owner regenerated the token', async () => {
      ghost.regenerateStaffKey();
      const err = await client()
        .configure(baseUrl(), demoDescriptor(), SLOT)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdminAccessLostError);
      expect((err as Error).message).toMatch(
        /slot "0": Ghost no longer accepts the stored owner access token \(401 \(Invalid token\)\): the site owner regenerated or revoked it; .* refused and the demo stays as it was/
      );
    });

    it('fails safe on a 403 the same way', async () => {
      ghost.overrides.set('PUT /settings/', { status: 403, body: { errors: [{ message: 'no' }] } });
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toBeInstanceOf(
        AdminAccessLostError
      );
    });

    it('fails safe when no token is stored for a site that already has its owner', async () => {
      await client().forget?.(SLOT);
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        'slot "0": no owner access token is stored for this site'
      );
      expect(
        ghost.requests.some((r) => r.path === '/authentication/setup/' && r.method === 'POST')
      ).toBe(false);
    });

    it('refuses when a setting does not read back as applied', async () => {
      ghost.readBackOverrides.set('members_support_address', 'noreply');
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        'Ghost did not apply members_support_address'
      );
    });

    it('refuses on any other settings failure', async () => {
      ghost.overrides.set('PUT /settings/', { status: 500 });
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        'Ghost refused the settings update: 500'
      );
    });

    it('treats a settings answer with no settings as not applied', async () => {
      ghost.overrides.set('PUT /settings/', { status: 200, body: {} });
      await expect(client().configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
        'Ghost did not apply codeinjection_head'
      );
    });

    it('forget deletes the stored token file', async () => {
      await client().forget?.(SLOT);
      await expect(stat(join(keyDir, '0', 'ghost-admin-key'))).rejects.toThrow(/ENOENT/);
      await client().forget?.(SLOT);
    });
  });
});

describe('the key store', () => {
  let base: string;
  const KEY = `${'1'.repeat(24)}:${'2'.repeat(64)}`;
  beforeEach(async () => {
    base = join(await makeTempDir('broker-keystore-'), 'keys');
  });

  it('refuses a slot that is not a plain name', async () => {
    const store = createAdminKeyStore(base);
    for (const slot of ['../x', 'a/b', '', '.']) {
      await expect(store.write(slot, KEY)).rejects.toThrow(/not a plain slot name/);
      await expect(store.read(slot)).rejects.toThrow(/not a plain slot name/);
    }
  });

  it('refuses to store anything that is not a key', async () => {
    await expect(createAdminKeyStore(base).write('0', 'password123')).rejects.toThrow(
      'refusing to store a value that is not a Ghost Admin API key'
    );
  });

  it('refuses to hand back a corrupted file', async () => {
    await mkdir(join(base, '0'), { recursive: true });
    await writeFile(join(base, '0', 'ghost-admin-key'), 'garbage\n', { mode: 0o600 });
    await expect(createAdminKeyStore(base).read('0')).rejects.toThrow(
      /is not a Ghost Admin API key/
    );
  });

  it('tightens an existing folder to 0700', async () => {
    await mkdir(join(base, '0'), { recursive: true, mode: 0o755 });
    await chmod(base, 0o755);
    await createAdminKeyStore(base).write('0', KEY);
    expect((await stat(base)).mode & 0o777).toBe(0o700);
    expect((await stat(join(base, '0'))).mode & 0o777).toBe(0o700);
  });

  it('refuses a slot folder that is a symlink', async () => {
    const elsewhere = await makeTempDir('broker-keystore-elsewhere-');
    await mkdir(base, { recursive: true });
    await symlink(elsewhere, join(base, '0'));
    const store = createAdminKeyStore(base);
    await expect(store.write('0', KEY)).rejects.toThrow(/not a plain directory/);
    await expect(store.remove('0')).rejects.toThrow(/not a plain directory/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('refuses a directory in place of the file', async () => {
    await mkdir(join(base, '0', 'ghost-admin-key'), { recursive: true });
    await expect(createAdminKeyStore(base).read('0')).rejects.toThrow('not a plain file');
  });

  it('surfaces a lookup error that is not "missing"', async () => {
    await mkdir(base, { recursive: true });
    await writeFile(join(base, '0'), 'not a folder');
    await expect(createAdminKeyStore(base).read('0')).rejects.toThrow(/ENOTDIR/);
  });

  it('removing from a slot that never had a folder is a no-op', async () => {
    await createAdminKeyStore(base).remove('3');
  });
});

describe('the Admin API token', () => {
  const KEY = `${'1'.repeat(24)}:${'ab'.repeat(32)}`;

  it('is HS256 over the hex secret, names the key, and lives five minutes', async () => {
    const token = adminApiToken(KEY, 1_000);
    const [h, p] = token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
      kid: '1'.repeat(24),
    });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iat: 1_000,
      exp: 1_300,
      aud: '/admin/',
    });
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex'))
      .update(`${h}.${p}`)
      .digest('base64url');
    expect(token.split('.')[2]).toBe(expected);
  });

  it('refuses something that is not a key', () => {
    expect(() => adminApiToken('nope', 1)).toThrow('not a Ghost Admin API key');
    expect(isAdminApiKey(KEY)).toBe(true);
    expect(isAdminApiKey(`${KEY}x`)).toBe(false);
  });
});

describe('the loopback transport', () => {
  it('returns a non-JSON body as text, and times out a silent server', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/text') {
        res.end('plain');
        return;
      }
      // never answers
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await loopbackGhostTransport({
        port,
        siteHost: 'x.example.test',
        method: 'GET',
        path: '/text',
        timeoutMs: 1_000,
      });
      expect(res.body).toBe('plain');
      await expect(
        loopbackGhostTransport({
          port,
          siteHost: 'x.example.test',
          method: 'GET',
          path: '/silent',
          timeoutMs: 100,
        })
      ).rejects.toThrow('Ghost did not answer GET /silent in time');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('adminApiConfigFromEnv', () => {
  const zonesEnv = {
    BROKER_DEMO_ZONE: TEST_ZONES.demoZone,
    BROKER_PLATFORM_ZONE: TEST_ZONES.platformZone,
    BROKER_OWNED_DOMAINS: TEST_ZONES.ownedDomains.join(','),
    BROKER_DEMO_MAIL_DOMAIN: TEST_ZONES.demoMailDomain,
  };

  it('has no default for the key folder', () => {
    expect(() => adminApiConfigFromEnv(zonesEnv)).toThrow(
      'Missing required environment variable BROKER_ADMIN_KEY_DIR'
    );
  });

  it('reads the folder and the ready budget', () => {
    expect(
      adminApiConfigFromEnv({
        ...zonesEnv,
        BROKER_ADMIN_KEY_DIR: '/k',
        BROKER_GHOST_READY_TIMEOUT_MS: '1234',
      })
    ).toMatchObject({ keyDir: '/k', readyTimeoutMs: 1234 });
  });
});

describe('the key store refuses a token it cannot trust', () => {
  const KEY = `${'1'.repeat(24)}:${'2'.repeat(64)}`;
  let base: string;
  beforeEach(async () => {
    base = join(await makeTempDir('broker-keytrust-'), 'keys');
    await createAdminKeyStore(base).write('0', KEY);
  });

  it('reads back a 0600 file it owns', async () => {
    expect(await createAdminKeyStore(base).read('0')).toBe(KEY);
  });

  it('refuses a file whose mode is not exactly 0600', async () => {
    for (const mode of [0o644, 0o640, 0o400, 0o700]) {
      await chmod(join(base, '0', 'ghost-admin-key'), mode);
      await expect(createAdminKeyStore(base).read('0')).rejects.toThrow(
        `mode ${mode.toString(8)}, not 600`
      );
    }
  });

  it('refuses a file owned by another account', async () => {
    const own = process.getuid?.() ?? 0;
    await expect(createAdminKeyStore(base, () => own + 1).read('0')).rejects.toThrow(
      `owned by uid ${own}, not this service`
    );
  });

  it('refuses a symlink in place of the file', async () => {
    const elsewhere = join(await makeTempDir('broker-keytrust-other-'), 'k');
    await writeFile(elsewhere, `${KEY}\n`, { mode: 0o600 });
    const path = join(base, '0', 'ghost-admin-key');
    await rm(path);
    await symlink(elsewhere, path);
    await expect(createAdminKeyStore(base).read('0')).rejects.toThrow('not a plain file');
  });
});
