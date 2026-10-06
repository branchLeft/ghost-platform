/**
 * LIVE: the real admin client against the pinned Ghost image, two colours
 * on one data volume as a swap runs them. Skips unless Docker answers and
 * the pinned image is already present locally. See
 * ghostAdminClient.live.test.md.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { AdminAccessLostError, createGhostAdminClient } from '../../src/ghostAdmin/client.js';
import { createAdminKeyStore } from '../../src/ghostAdmin/keyStore.js';
import { loopbackGhostTransport } from '../../src/ghostAdmin/request.js';
import { adminApiToken } from '../../src/ghostAdmin/token.js';
import { demoDescriptor, TEST_ZONES } from '../helpers/fixtures.js';
import { findFreePort } from '../helpers/spawnBroker.js';

const IMAGE =
  'ghost:6.55.0-alpine@sha256:de23ea18e09f1f6e94dd323c831c3821494fa054b7a55984a5bd0b817fcab918';
const SLOT = '0' as SlotName;
const RUN = randomBytes(4).toString('hex');
const VOLUME = `broker-admin-live-${RUN}`;
const LABEL = `broker-admin-live-${RUN}`;

function docker(args: string[]): { status: number | null; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 120_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const canRun = docker(['info']).status === 0 && docker(['image', 'inspect', IMAGE]).status === 0;

const descriptor = demoDescriptor();
const siteHost = new URL(descriptor.siteUrl).host;

function ensureVolume(): void {
  const r = docker(['volume', 'create', '--label', `branchleft.test=${LABEL}`, VOLUME]);
  if (r.status !== 0) throw new Error(`could not create ${VOLUME}: ${r.out}`);
}

function startColour(name: string, port: number): void {
  const r = docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--label',
    `branchleft.test=${LABEL}`,
    '-p',
    `127.0.0.1:${port}:2368`,
    '-v',
    `${VOLUME}:/var/lib/ghost/content/data`,
    '-e',
    `url=${descriptor.siteUrl}`,
    '-e',
    'NODE_ENV=production',
    '-e',
    'database__client=sqlite3',
    '-e',
    'database__connection__filename=/var/lib/ghost/content/data/ghost.db',
    '-e',
    'mail__transport=stub',
    '-e',
    'security__allowWebhookInternalIPs=false',
    '-e',
    'privacy__useUpdateCheck=false',
    IMAGE,
  ]);
  if (r.status !== 0) throw new Error(`could not start ${name}: ${r.out}`);
}

async function readSettings(port: number, key: string): Promise<Map<string, unknown>> {
  const res = await loopbackGhostTransport({
    port,
    siteHost,
    method: 'GET',
    path: '/ghost/api/admin/settings/',
    headers: { Authorization: `Ghost ${adminApiToken(key, Math.floor(Date.now() / 1000))}` },
    timeoutMs: 15_000,
  });
  const settings = (res.body as { settings?: { key: string; value: unknown }[] }).settings ?? [];
  return new Map(settings.map((s) => [s.key, s.value]));
}

async function putSettings(port: number, key: string, values: Record<string, string>) {
  return loopbackGhostTransport({
    port,
    siteHost,
    method: 'PUT',
    path: '/ghost/api/admin/settings/',
    headers: { Authorization: `Ghost ${adminApiToken(key, Math.floor(Date.now() / 1000))}` },
    body: { settings: Object.entries(values).map(([k, value]) => ({ key: k, value })) },
    timeoutMs: 15_000,
  });
}

describe.skipIf(!canRun)('LIVE — the admin client against Ghost 6.55.0', () => {
  const colourA = `broker-admin-live-a-${RUN}`;
  const colourB = `broker-admin-live-b-${RUN}`;
  let portA = 0;
  let portB = 0;
  let keyDir = '';
  const keyPath = () => join(keyDir, SLOT, 'ghost-admin-key');
  const client = () =>
    createGhostAdminClient({
      keyStore: createAdminKeyStore(keyDir),
      zones: TEST_ZONES,
      readyTimeoutMs: 180_000,
    });

  beforeAll(async () => {
    keyDir = join(await makeTempDir('broker-admin-live-'), 'admin-keys');
    portA = await findFreePort();
    portB = await findFreePort();
    ensureVolume();
    startColour(colourA, portA);
  }, 120_000);

  afterAll(() => {
    docker(['rm', '-f', '-v', colourA, colourB]);
    docker(['volume', 'rm', '-f', VOLUME]);
  });

  it('first build: sets up the site, stores only the staff token (0600), applies all three settings', async () => {
    await client().configure(`http://127.0.0.1:${portA}`, descriptor, SLOT);

    const key = (await readFile(keyPath(), 'utf8')).trim();
    expect((await stat(keyPath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(keyDir, SLOT))).mode & 0o777).toBe(0o700);
    const settings = await readSettings(portA, key);
    expect(settings.get('codeinjection_head') ?? '').toBe('');
    expect(settings.get('codeinjection_foot') ?? '').toBe('');
    expect(settings.get('members_support_address')).toBe(`demo-1@${TEST_ZONES.demoMailDomain}`);
    expect(settings.get('title')).toBe('ALL_CAPS_PLACEHOLDER_SITE_TITLE');
  }, 240_000);

  it('swap: a second colour on the same data re-applies all three settings with the stored token', async () => {
    const key = (await readFile(keyPath(), 'utf8')).trim();
    const tampered = await putSettings(portA, key, {
      codeinjection_head: '<script>prospectHead()</script>',
      codeinjection_foot: '<script>prospectFoot()</script>',
      members_support_address: 'noreply',
    });
    expect(tampered.status).toBe(200);

    startColour(colourB, portB);
    await client().configure(`http://127.0.0.1:${portB}`, descriptor, SLOT);

    // Only the colour being configured is checked: each Ghost process caches
    // settings in memory, so the old colour keeps its own view until it is
    // drained and stopped, which the swap does next.
    const settings = await readSettings(portB, key);
    expect(settings.get('codeinjection_head') ?? '').toBe('');
    expect(settings.get('codeinjection_foot') ?? '').toBe('');
    expect(settings.get('members_support_address')).toBe(`demo-1@${TEST_ZONES.demoMailDomain}`);
    expect((await readFile(keyPath(), 'utf8')).trim()).toBe(key);
  }, 240_000);

  it('a regenerated token: the next configure fails safe and changes nothing', async () => {
    const key = (await readFile(keyPath(), 'utf8')).trim();
    const me = await loopbackGhostTransport({
      port: portB,
      siteHost,
      method: 'GET',
      path: '/ghost/api/admin/users/me/',
      headers: { Authorization: `Ghost ${adminApiToken(key, Math.floor(Date.now() / 1000))}` },
      timeoutMs: 15_000,
    });
    const id = (me.body as { users: { id: string }[] }).users[0]?.id;
    // What the prospect does in their profile: regenerate the token.
    const regen = await loopbackGhostTransport({
      port: portB,
      siteHost,
      method: 'PUT',
      path: `/ghost/api/admin/users/${id}/token/`,
      headers: { Authorization: `Ghost ${adminApiToken(key, Math.floor(Date.now() / 1000))}` },
      timeoutMs: 15_000,
    });
    expect(regen.status).toBe(200);
    const fresh = (regen.body as { apiKey: { id: string; secret: string } }).apiKey;
    const newKey = `${fresh.id}:${fresh.secret}`;
    expect(newKey).not.toBe(key);
    await putSettings(portB, newKey, { codeinjection_head: '<script>kept()</script>' });

    const err = await client()
      .configure(`http://127.0.0.1:${portB}`, descriptor, SLOT)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminAccessLostError);
    expect((err as Error).message).toMatch(/regenerated or revoked/);
    const settings = await readSettings(portB, newKey);
    expect(settings.get('codeinjection_head')).toBe('<script>kept()</script>');
  }, 120_000);

  it('reset: forget deletes the token file', async () => {
    await client().forget?.(SLOT);
    await expect(stat(keyPath())).rejects.toThrow(/ENOENT/);
  });
});

describe.skipIf(canRun)('LIVE admin client proof — skipped', () => {
  it('needs Docker and the pinned Ghost image present locally', () => {
    expect(canRun).toBe(false);
  });
});
