import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDeps, loadPlugin } from '../../src/server.js';
import type { BrokerConfig } from '../../src/config.js';
import { makeTempDir } from '../../src/atomicFile.js';
import { generateTestKeyPair, signHeaders } from '../helpers/signer.js';
import {
  writeShapelessPlugin,
  writeValidAdminApiPlugin,
  writeValidDrainSourcePlugin,
  writeValidRendererPlugin,
} from '../helpers/pluginFixtures.js';
import { findFreePort, spawnBroker, type SpawnedBroker } from '../helpers/spawnBroker.js';
import { demoDescriptor, TEST_ZONES } from '../helpers/fixtures.js';

function fakeConfig(overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    slotsPath: '/tmp/does-not-matter-for-buildDeps/slots.json',
    leaseDir: '/tmp/does-not-matter-for-buildDeps/lease',
    stateDir: '/tmp/does-not-matter-for-buildDeps/state',
    drainFlagDir: '/tmp/does-not-matter-for-buildDeps/drain',
    slotDirBase: '/tmp/does-not-matter-for-buildDeps/slots',
    verifyKey: Buffer.alloc(32, 1),
    replayWindowSeconds: 60,
    wrapperCommand: '/bin/true',
    wrapperPrefix: [],
    wrapperTimeoutMs: 1000,
    zones: TEST_ZONES,
    slotLiterals: ['0'],
    drainPollTimeoutMs: 1000,
    healthCheckTimeoutMs: 1000,
    healthPortBase: 9100,
    appPortBase: 9300,
    processStartSeconds: 1_700_000_000,
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe('buildDeps (F5: the wiring server.ts actually uses)', () => {
  it('wires a real, stateful nonce store -- not a stub that always admits', () => {
    const deps = buildDeps(
      fakeConfig(),
      { render: async () => [] },
      { configure: async () => undefined },
      { poll: async () => new Promise(() => undefined) }
    );
    const nowMs = 1_700_000_000_000;
    expect(deps.auth.nonces.claim('abc', nowMs)).toBe(true);
    expect(deps.auth.nonces.claim('abc', nowMs)).toBe(false);
  });

  it('wires a real per-slot lock -- not one that always grants a claim', () => {
    const deps = buildDeps(
      fakeConfig(),
      { render: async () => [] },
      { configure: async () => undefined },
      { poll: async () => new Promise(() => undefined) }
    );
    const slot = '0' as never;
    expect(deps.slotLock.claim(slot)).toBe(true);
    expect(deps.slotLock.claim(slot)).toBe(false);
  });

  it('carries processStartSeconds from config through to auth -- the F3 fix', () => {
    const deps = buildDeps(
      fakeConfig({ processStartSeconds: 123456 }),
      { render: async () => [] },
      { configure: async () => undefined },
      { poll: async () => new Promise(() => undefined) }
    );
    expect(deps.auth.processStartSeconds).toBe(123456);
  });
});

describe('loadPlugin (F5: default-export shape checking)', () => {
  it('refuses a module whose default export has none of the required functions', async () => {
    const dir = await makeTempDir('broker-plugin-shape-');
    const path = await writeShapelessPlugin(dir, 'bad-renderer');
    await expect(
      loadPlugin(
        'X_MODULE',
        { X_MODULE: path },
        (c: unknown): c is { render: () => void } =>
          typeof (c as { render?: unknown } | undefined)?.render === 'function'
      )
    ).rejects.toThrow(/has no default export implementing the required interface/);
  });

  it('accepts a module whose default export has the required function', async () => {
    const dir = await makeTempDir('broker-plugin-shape-');
    const path = await writeValidRendererPlugin(dir);
    const plugin = await loadPlugin(
      'X_MODULE',
      { X_MODULE: path },
      (c: unknown): c is { render: () => void } =>
        typeof (c as { render?: unknown } | undefined)?.render === 'function'
    );
    expect(typeof plugin.render).toBe('function');
  });
});

/**
 * F5's strongest proof: the real entrypoint (`dist/server.js`), spawned as
 * its own process and driven over real HTTP -- not `buildDeps` imported
 * in-process, and not `test/helpers/testBroker.ts`'s own hand-built
 * `BrokerDeps` (which proves the handler logic, never that `server.ts`
 * wires it the same way a real deploy would run it).
 */
describe('the real dist/server.js entrypoint', () => {
  let broker: SpawnedBroker | undefined;

  afterEach(() => {
    broker?.stop();
    broker = undefined;
  });

  async function baseEnv(): Promise<{
    env: Record<string, string>;
    keyPair: ReturnType<typeof generateTestKeyPair>;
  }> {
    const root = await makeTempDir('broker-spawn-');
    const keyPair = generateTestKeyPair();
    const keyPath = join(root, 'verify.key');
    await writeFile(keyPath, keyPair.publicKeyRaw);
    const stateDir = join(root, 'state');
    const leaseDir = join(root, 'lease');
    const drainFlagDir = join(root, 'drain');
    const slotDirBase = join(root, 'slots');
    await mkdir(stateDir, { recursive: true });
    await mkdir(leaseDir, { recursive: true });
    await mkdir(drainFlagDir, { recursive: true });
    await mkdir(slotDirBase, { recursive: true });
    return {
      keyPair,
      env: {
        PORT: String(await findFreePort()),
        LISTEN_HOST: '127.0.0.1',
        BROKER_VERIFY_KEY_FILE: keyPath,
        BROKER_SLOTS_FILE: join(root, 'slots.json'),
        BROKER_LEASE_DIR: leaseDir,
        BROKER_STATE_DIR: stateDir,
        BROKER_DRAIN_FLAG_DIR: drainFlagDir,
        BROKER_SLOT_DIR_BASE: slotDirBase,
        BROKER_DEMO_ZONE: TEST_ZONES.demoZone,
        BROKER_PLATFORM_ZONE: TEST_ZONES.platformZone,
        BROKER_OWNED_DOMAINS: TEST_ZONES.ownedDomains.join(','),
        BROKER_WRAPPER_COMMAND: join(process.cwd(), 'test/helpers/fakeWrapper.mjs'),
        BROKER_WRAPPER_PREFIX: process.execPath,
        BROKER_SLOT_LITERALS: '0,1,2,3,4,5,6',
      },
    };
  }

  it('exits non-zero and never listens when no plugin module is configured', async () => {
    const { env } = await baseEnv();
    broker = spawnBroker(env);
    const code = await broker.waitExit(8000);
    expect(code).not.toBe(0);
    expect(broker.output()).toMatch(/BROKER_RENDERER_MODULE is not set/);
  });

  it('exits non-zero when a plugin module has no default export implementing its interface', async () => {
    const root = await makeTempDir('broker-plugin-');
    const { env } = await baseEnv();
    const badRenderer = await writeShapelessPlugin(root, 'bad-renderer');
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    broker = spawnBroker({
      ...env,
      BROKER_RENDERER_MODULE: badRenderer,
      BROKER_ADMIN_API_MODULE: adminApi,
      BROKER_DRAIN_SOURCE_MODULE: drainSource,
    });
    const code = await broker.waitExit(8000);
    expect(code).not.toBe(0);
    expect(broker.output()).toMatch(/no default export implementing the required interface/);
  });

  it('starts, listens, verifies against the configured key, and actually enforces replay protection -- wired exactly as a real deploy would run it', async () => {
    const root = await makeTempDir('broker-plugin-');
    const { env, keyPair } = await baseEnv();
    const renderer = await writeValidRendererPlugin(root);
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    broker = spawnBroker({
      ...env,
      BROKER_RENDERER_MODULE: renderer,
      BROKER_ADMIN_API_MODULE: adminApi,
      BROKER_DRAIN_SOURCE_MODULE: drainSource,
    });
    const { port } = await broker.waitListening(8000);
    const baseUrl = `http://127.0.0.1:${port}`;

    // Wrong key: the process must refuse, proving it verifies against the
    // BROKER_VERIFY_KEY_FILE it was actually started with, not merely
    // whatever key its own test happens to hold.
    const wrongKeyPair = generateTestKeyPair();
    const body = Buffer.from(JSON.stringify({ slot: '0', descriptor: demoDescriptor() }));
    const wrongHeaders = signHeaders(
      wrongKeyPair,
      'POST',
      '/reconcile',
      body,
      Math.floor(Date.now() / 1000)
    );
    const wrongKeyRes = await fetch(`${baseUrl}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...wrongHeaders },
      body,
    });
    expect(wrongKeyRes.status).toBe(401);

    // The right key, real signing, a real reconcile end to end through the
    // spawned process's own router, real plugin modules and the real
    // fakeWrapper.mjs stand-in for the sudoers wrapper.
    const rightHeaders = signHeaders(
      keyPair,
      'POST',
      '/reconcile',
      body,
      Math.floor(Date.now() / 1000)
    );
    const okRes = await fetch(`${baseUrl}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...rightHeaders },
      body,
    });
    expect(okRes.status).toBe(200);

    // The exact same request, replayed: if `main()` wired a real nonce
    // store (not a sabotaged always-admit stub, F5's Sabotage A), this must
    // now be refused.
    const replayRes = await fetch(`${baseUrl}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...rightHeaders },
      body,
    });
    expect(replayRes.status).toBe(401);

    // /status needs no signature at all (LLD-2 §03).
    const statusRes = await fetch(`${baseUrl}/status/0`);
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ slot: '0', phase: 'running', healthy: false });
  });
});
