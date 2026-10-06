import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailAddress, SlotName } from '@branchleft/ghost-platform-render-core';
import type { AdminApiClient } from '../../src/adminApi.js';
import { makeTempDir } from '../../src/atomicFile.js';
import { writeLeaseAndHash } from '../../src/leaseStore.js';
import { createGhostAdminClient } from '../../src/ghostAdmin/client.js';
import { createAdminKeyStore } from '../../src/ghostAdmin/keyStore.js';
import { demoDescriptor, TEST_ZONES } from '../helpers/fixtures.js';
import { startFakeGhost, type FakeGhost } from '../helpers/fakeGhost.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

/**
 * The real client behind the real handler. The test broker's fixed app
 * port is not where the fake Ghost listens, so the client is wrapped to
 * redirect each call to it; everything else is the production path.
 */
function pointedAt(ghost: FakeGhost, inner: AdminApiClient): AdminApiClient {
  return {
    configure: (_url, descriptor, slot) =>
      inner.configure(`http://127.0.0.1:${ghost.port}`, descriptor, slot),
    forget: (slot) => inner.forget?.(slot) ?? Promise.resolve(),
  };
}

describe('the admin client wired into reconcile and reset', () => {
  let broker: TestBroker | undefined;
  let ghost: FakeGhost | undefined;
  afterEach(async () => {
    await broker?.close();
    await ghost?.close();
    broker = undefined;
    ghost = undefined;
  });

  async function start(): Promise<{ keyDir: string; log: string[] }> {
    ghost = await startFakeGhost();
    const keyDir = join(await makeTempDir('broker-wired-keys-'), 'keys');
    const log: string[] = [];
    const real = createGhostAdminClient({
      keyStore: createAdminKeyStore(keyDir),
      zones: TEST_ZONES,
      readyTimeoutMs: 2_000,
      sleep: async () => undefined,
    });
    const g = ghost;
    broker = await startTestBroker({
      wrapDeps: (deps) => ({ ...deps, adminApi: pointedAt(g, real), log: (l) => log.push(l) }),
    });
    return { keyDir, log };
  }

  it('first build stores the token; a swap re-applies with it; a reset deletes it', async () => {
    const { keyDir } = await start();
    const keyPath = join(keyDir, '0', 'ghost-admin-key');
    const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
    const built = await broker!.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first });
    expect(built.status).toBe(200);
    expect((await readFile(keyPath, 'utf8')).trim()).toBe(ghost!.staffKey());

    ghost!.settings.set('codeinjection_head', '<script>x()</script>');
    const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });
    const swapped = await broker!.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: second,
    });
    expect(swapped.status).toBe(200);
    expect(await swapped.json()).toMatchObject({ phase: 'running', colour: 'b' });
    expect(ghost!.settings.get('codeinjection_head')).toBeNull();

    const reset = await broker!.signedFetch('POST', '/reset', { slot: '0' });
    expect(reset.status).toBe(200);
    await expect(stat(keyPath)).rejects.toThrow(/ENOENT/);
  });

  it('a regenerated token refuses the swap and leaves the demo on its current colour, with the reason', async () => {
    const { log } = await start();
    const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
    await broker!.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first });

    ghost!.regenerateStaffKey();
    const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });
    const res = await broker!.signedFetch('POST', '/reconcile', { slot: '0', descriptor: second });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, string>;
    expect(body).toMatchObject({ slot: '0', phase: 'running', colour: 'a' });
    expect(body.error).toMatch(/regenerated or revoked it; .* the demo stays as it was/);
    expect(log.some((l) => l.includes('regenerated or revoked'))).toBe(true);
    const status = await fetch(`${broker!.baseUrl}/status/0`);
    expect(await status.json()).toMatchObject({ phase: 'running' });
  });
});

describe('reset forgets before it wipes', () => {
  let broker: TestBroker | undefined;
  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it('calls forget for the slot, and a failing forget ends the reset in error', async () => {
    const forgotten: SlotName[] = [];
    let failForget = false;
    broker = await startTestBroker({
      wrapDeps: (deps) => ({
        ...deps,
        adminApi: {
          configure: (u, d, s) => deps.adminApi.configure(u, d, s),
          forget: async (slot) => {
            if (failForget) throw new Error('disk gone');
            forgotten.push(slot);
          },
        },
      }),
    });
    await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: demoDescriptor() });
    const ok = await broker.signedFetch('POST', '/reset', { slot: '0' });
    expect(ok.status).toBe(200);
    expect(forgotten).toEqual(['0']);

    await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: demoDescriptor() });
    failForget = true;
    const failed = await broker.signedFetch('POST', '/reset', { slot: '0' });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ slot: '0', phase: 'error' });
    const wrapperLog = await readFile(broker.wrapperLogPath, 'utf8');
    expect(wrapperLog.split('\n').filter((l) => l.includes('reset'))).toHaveLength(1);
  });

  it('the fresh-build retry forgets before its reset', async () => {
    const forgotten: SlotName[] = [];
    broker = await startTestBroker({
      wrapDeps: (deps) => ({
        ...deps,
        adminApi: {
          configure: async () => {
            throw new Error('no');
          },
          forget: async (slot) => {
            forgotten.push(slot);
          },
        },
      }),
    });
    const res = await broker.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: demoDescriptor(),
    });
    expect(res.status).toBe(503);
    expect(forgotten).toEqual(['0']);
  });
});

describe('the shipped plugin module', () => {
  it('is marked real and reads its folder from the environment when loaded', async () => {
    const keyDir = await makeTempDir('broker-plugin-keys-');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BROKER_ADMIN_KEY_DIR: keyDir,
      BROKER_DEMO_ZONE: TEST_ZONES.demoZone,
      BROKER_PLATFORM_ZONE: TEST_ZONES.platformZone,
      BROKER_OWNED_DOMAINS: TEST_ZONES.ownedDomains.join(','),
      BROKER_DEMO_MAIL_DOMAIN: TEST_ZONES.demoMailDomain,
    });
    try {
      const mod = (await import('../../src/plugins/ghostAdminApi.js')).default;
      expect(mod.real).toBe(true);
      expect(typeof mod.configure).toBe('function');
      await mod.forget?.('0' as SlotName);
    } finally {
      process.env = saved;
    }
  });
});

describe('the host-conflict teardown forgets the token too', () => {
  let broker: TestBroker | undefined;
  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  // Another slot takes the host inside configure, so this slot's own lease
  // write hits the atomic host-conflict backstop.
  async function conflict(forgetFails: boolean): Promise<{ status: number; forgotten: string[] }> {
    const forgotten: string[] = [];
    const descriptor = demoDescriptor();
    const host = new URL(descriptor.siteUrl).host;
    broker = await startTestBroker({
      wrapDeps: (deps) => ({
        ...deps,
        adminApi: {
          configure: async () => {
            await writeLeaseAndHash(deps.leaseStoreConfig, host, '1' as SlotName, '$argon2id$x');
          },
          forget: async (slot) => {
            if (forgetFails) throw new Error('disk gone');
            forgotten.push(slot);
          },
        },
      }),
    });
    const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor });
    return { status: res.status, forgotten };
  }

  it('forgets the slot before the wipe and frees it', async () => {
    expect(await conflict(false)).toEqual({ status: 409, forgotten: ['0'] });
  });

  it('a failed forget leaves the slot in error, never free', async () => {
    expect((await conflict(true)).status).toBe(503);
    const state = JSON.parse(await readFile(join(broker!.stateDir, '0.json'), 'utf8'));
    expect(state.phase).toBe('error');
  });
});
