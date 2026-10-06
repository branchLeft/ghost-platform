import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashIdOf } from '@branchleft/ghost-platform-render-core';
import { buildDeps, loadPlugin } from '../../src/server.js';
import type { BrokerConfig } from '../../src/config.js';
import { makeTempDir } from '../../src/atomicFile.js';
import { imagePushManifest } from '../../src/imagePush.js';
import { generateTestKeyPair, signHeaders } from '../helpers/signer.js';
import {
  writeShapelessPlugin,
  writeValidAdminApiPlugin,
  writeValidDrainSourcePlugin,
  writeValidImageLoaderPlugin,
  writeValidRendererPlugin,
} from '../helpers/pluginFixtures.js';
import { findFreePort, spawnBroker, type SpawnedBroker } from '../helpers/spawnBroker.js';
import { demoDescriptor, TEST_ZONES } from '../helpers/fixtures.js';
import { descriptorHash } from '../../src/descriptorHash.js';
import { writeLeaseAndHash } from '../../src/leaseStore.js';
import { writeSlotState } from '../../src/stateStore.js';

function fakeConfig(overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    slotsPath: '/tmp/does-not-matter-for-buildDeps/slots.json',
    leaseDir: '/tmp/does-not-matter-for-buildDeps/lease',
    stateDir: '/tmp/does-not-matter-for-buildDeps/state',
    drainFlagDir: '/tmp/does-not-matter-for-buildDeps/drain',
    slotDirBase: '/tmp/does-not-matter-for-buildDeps/slots',
    imageTmpDir: '/tmp/does-not-matter-for-buildDeps/image-tmp',
    imageMaxBytes: 4 * 1024 * 1024 * 1024,
    verifyKey: Buffer.alloc(32, 1),
    replayWindowSeconds: 60,
    wrapperCommand: '/bin/true',
    wrapperPrefix: [],
    wrapperTimeoutMs: 1000,
    zones: TEST_ZONES,
    slotLiterals: ['0'],
    drainPollTimeoutMs: 1000,
    healthCheckTimeoutMs: 1000,
    ghostReadyPollTimeoutMs: 1000,
    healthPortBase: 9100,
    appPortBase: 9300,
    uidBase: 30001,
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
      { poll: async () => new Promise(() => undefined) },
      { load: async () => ({ imageId: 'sha256:' + '0'.repeat(64) }) }
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
      { poll: async () => new Promise(() => undefined) },
      { load: async () => ({ imageId: 'sha256:' + '0'.repeat(64) }) }
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
      { poll: async () => new Promise(() => undefined) },
      { load: async () => ({ imageId: 'sha256:' + '0'.repeat(64) }) }
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
    stateDir: string;
    leaseDir: string;
    drainFlagDir: string;
    slotsPath: string;
  }> {
    const root = await makeTempDir('broker-spawn-');
    const keyPair = generateTestKeyPair();
    const keyPath = join(root, 'verify.key');
    await writeFile(keyPath, keyPair.publicKeyRaw);
    const stateDir = join(root, 'state');
    const leaseDir = join(root, 'lease');
    const drainFlagDir = join(root, 'drain');
    const slotDirBase = join(root, 'slots');
    const slotsPath = join(root, 'slots.json');
    const imageTmpDir = join(root, 'image-tmp');
    await mkdir(stateDir, { recursive: true });
    await mkdir(leaseDir, { recursive: true });
    await mkdir(drainFlagDir, { recursive: true });
    await mkdir(slotDirBase, { recursive: true });
    await mkdir(imageTmpDir, { recursive: true });
    return {
      keyPair,
      stateDir,
      leaseDir,
      drainFlagDir,
      slotsPath,
      env: {
        PORT: String(await findFreePort()),
        LISTEN_HOST: '127.0.0.1',
        BROKER_VERIFY_KEY_FILE: keyPath,
        BROKER_SLOTS_FILE: slotsPath,
        BROKER_LEASE_DIR: leaseDir,
        BROKER_STATE_DIR: stateDir,
        BROKER_DRAIN_FLAG_DIR: drainFlagDir,
        BROKER_SLOT_DIR_BASE: slotDirBase,
        BROKER_IMAGE_TMP_DIR: imageTmpDir,
        BROKER_DEMO_ZONE: TEST_ZONES.demoZone,
        BROKER_PLATFORM_ZONE: TEST_ZONES.platformZone,
        BROKER_OWNED_DOMAINS: TEST_ZONES.ownedDomains.join(','),
        BROKER_DEMO_MAIL_DOMAIN: TEST_ZONES.demoMailDomain,
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

  it('exits non-zero and never listens when no image-loader module is configured', async () => {
    const root = await makeTempDir('broker-plugin-');
    const { env } = await baseEnv();
    const renderer = await writeValidRendererPlugin(root);
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    broker = spawnBroker({
      ...env,
      BROKER_RENDERER_MODULE: renderer,
      BROKER_ADMIN_API_MODULE: adminApi,
      BROKER_DRAIN_SOURCE_MODULE: drainSource,
      // BROKER_IMAGE_LOADER_MODULE deliberately left unset.
    });
    const code = await broker.waitExit(8000);
    expect(code).not.toBe(0);
    expect(broker.output()).toMatch(/BROKER_IMAGE_LOADER_MODULE is not set/);
  });

  it('starts, listens, verifies against the configured key, and actually enforces replay protection -- wired exactly as a real deploy would run it', async () => {
    const root = await makeTempDir('broker-plugin-');
    const { env, keyPair } = await baseEnv();
    const renderer = await writeValidRendererPlugin(root);
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    const imageLoader = await writeValidImageLoaderPlugin(root);
    broker = spawnBroker({
      ...env,
      BROKER_RENDERER_MODULE: renderer,
      BROKER_ADMIN_API_MODULE: adminApi,
      BROKER_DRAIN_SOURCE_MODULE: drainSource,
      BROKER_IMAGE_LOADER_MODULE: imageLoader,
    });
    const { port } = await broker.waitListening(8000);
    const baseUrl = `http://127.0.0.1:${port}`;

    // Item 2's floor is now `<=`: a request timestamped in the same
    // wall-clock second as `processStartSeconds` is refused, an accepted
    // cost. A fast local spawn can still be within that same second by
    // the time `waitListening` resolves, so every authenticated request
    // below waits past it first -- the real-server proof this test exists
    // for is replay protection, not the same-second edge (auth.test.ts
    // proves that edge directly and deterministically).
    await new Promise((resolve) => setTimeout(resolve, 1100));

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
    expect(await statusRes.json()).toEqual({
      slot: '0',
      phase: 'running',
      healthy: false,
      notReal: ['adminApi', 'drainSource', 'imageLoader', 'renderer'],
      interim: [],
    });
  });

  it('starts on the shipped modules with nothing to report, and lists an unmarked stand-in as not real', async () => {
    const distPlugins = join(process.cwd(), 'dist/plugins');
    const shippedPlugins = {
      BROKER_RENDERER_MODULE: join(distPlugins, 'renderCorePlugin.js'),
      BROKER_ADMIN_API_MODULE: join(distPlugins, 'ghostAdminApi.js'),
      BROKER_ADMIN_KEY_DIR: await makeTempDir('broker-spawn-keys-'),
      BROKER_IMAGE_LOADER_MODULE: join(distPlugins, 'dockerImageLoader.js'),
    };

    broker = spawnBroker({
      ...(await baseEnv()).env,
      ...shippedPlugins,
      BROKER_DRAIN_SOURCE_MODULE: join(distPlugins, 'refusingDrainSource.js'),
    });
    const shipped = await broker.waitListening(8000);
    const shippedStatus = await fetch(`http://127.0.0.1:${shipped.port}/status/0`);
    expect(await shippedStatus.json()).toEqual({
      slot: '0',
      phase: 'free',
      healthy: false,
      notReal: [],
      interim: [],
    });
    broker.stop();

    broker = spawnBroker({
      ...(await baseEnv()).env,
      ...shippedPlugins,
      BROKER_DRAIN_SOURCE_MODULE: join(
        process.cwd(),
        'test/live/fixtures/systemd-boot/noop-drain-source.mjs'
      ),
    });
    const withStandIn = await broker.waitListening(8000);
    const standInStatus = await fetch(`http://127.0.0.1:${withStandIn.port}/status/0`);
    expect(await standInStatus.json()).toMatchObject({
      notReal: ['drainSource'],
      interim: [],
    });
  });

  // --- push delivery, end to end through the real spawned process: a real
  // Ed25519-signed push, over real HTTP, reaching the real dist/server.js
  // -- not `startTestBroker()`'s in-process router (imagePush.test.ts
  // already proves the handler's own logic there). ---
  it('POST /image end to end through the real spawned process: matching digest loads, mismatched digest is refused', async () => {
    const root = await makeTempDir('broker-plugin-');
    const { env, keyPair } = await baseEnv();
    const renderer = await writeValidRendererPlugin(root);
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    const imageLoader = await writeValidImageLoaderPlugin(root);
    broker = spawnBroker({
      ...env,
      BROKER_RENDERER_MODULE: renderer,
      BROKER_ADMIN_API_MODULE: adminApi,
      BROKER_DRAIN_SOURCE_MODULE: drainSource,
      BROKER_IMAGE_LOADER_MODULE: imageLoader,
    });
    const { port } = await broker.waitListening(8000);
    const baseUrl = `http://127.0.0.1:${port}`;
    await new Promise((resolve) => setTimeout(resolve, 1100)); // past the same-second floor

    const bytes = Buffer.from('a stand-in for a real docker-save tar');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const size = String(bytes.length);
    const manifest = imagePushManifest(digest, size);
    const goodHeaders = signHeaders(
      keyPair,
      'POST',
      '/image',
      manifest,
      Math.floor(Date.now() / 1000)
    );
    const goodRes = await fetch(`${baseUrl}/image`, {
      method: 'POST',
      headers: { ...goodHeaders, 'X-Image-Digest': digest, 'X-Image-Size': size },
      body: bytes,
    });
    expect(goodRes.status).toBe(200);
    const goodBody = (await goodRes.json()) as { imageId: string; bytes: number };
    expect(goodBody.imageId).toBe(`sha256:${'0'.repeat(64)}`); // the fixture's fixed ImageLoader answer
    expect(goodBody.bytes).toBe(bytes.length);

    const wrongDigest = `sha256:${'f'.repeat(64)}`;
    const wrongManifest = imagePushManifest(wrongDigest, size);
    const badHeaders = signHeaders(
      keyPair,
      'POST',
      '/image',
      wrongManifest,
      Math.floor(Date.now() / 1000)
    );
    const badRes = await fetch(`${baseUrl}/image`, {
      method: 'POST',
      headers: { ...badHeaders, 'X-Image-Digest': wrongDigest, 'X-Image-Size': size },
      body: bytes,
    });
    expect(badRes.status).toBe(409);
  });

  // --- The colour swap, driven through the real spawned
  // entrypoint -- proving `buildDeps` wires `ghostReadiness` to a real HTTP
  // client against the real dist/server.js, not merely that app.ts's own
  // logic is correct against a hand-built BrokerDeps (app.test.ts already
  // proves that). A fake Ghost stands in for the target colour's real one,
  // exactly as `fakeWrapper.mjs` stands in for the sudoers wrapper. ---
  it('swaps a running slot into its other colour end to end, verifying the target directly before moving traffic', async () => {
    const root = await makeTempDir('broker-plugin-');
    const { env, keyPair } = await baseEnv();
    const renderer = await writeValidRendererPlugin(root);
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    const imageLoader = await writeValidImageLoaderPlugin(root);
    // Slot "0"'s own derived allocation under this spawn's default bases
    // (unchanged from `baseEnv()`) is exactly `demoDescriptor()`'s own
    // default ports -- colour "b" is 9301 (slotPorts.ts: appPortBase=9300
    // + 0*2 + 1). This fake Ghost binds there directly rather than probing
    // a free port and overriding `BROKER_APP_PORT_BASE`: an OS-assigned
    // ephemeral port can exceed `positiveInteger`'s 65000 cap on this
    // config value, which would fail the spawn instead of proving the swap.
    const targetGhostPort = 9301;
    const fakeGhost: Server = createServer((_req, res) => res.writeHead(200).end('ok'));
    await new Promise<void>((resolve) => fakeGhost.listen(targetGhostPort, '127.0.0.1', resolve));
    try {
      broker = spawnBroker({
        ...env,
        BROKER_RENDERER_MODULE: renderer,
        BROKER_ADMIN_API_MODULE: adminApi,
        BROKER_DRAIN_SOURCE_MODULE: drainSource,
        BROKER_IMAGE_LOADER_MODULE: imageLoader,
        BROKER_GHOST_READY_TIMEOUT_MS: '5000',
      });
      const { port } = await broker.waitListening(8000);
      const baseUrl = `http://127.0.0.1:${port}`;
      await new Promise((resolve) => setTimeout(resolve, 1100)); // past the same-second replay floor

      const first = demoDescriptor({ ownerEmail: 'first@example.com' as never });
      const firstBody = Buffer.from(JSON.stringify({ slot: '0', descriptor: first }));
      const firstHeaders = signHeaders(
        keyPair,
        'POST',
        '/reconcile',
        firstBody,
        Math.floor(Date.now() / 1000)
      );
      const firstRes = await fetch(`${baseUrl}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...firstHeaders },
        body: firstBody,
      });
      expect(firstRes.status).toBe(200);
      expect(await firstRes.json()).toEqual({ slot: '0', phase: 'running', colour: 'a' });

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const second = demoDescriptor({ ownerEmail: 'second@example.com' as never });
      const secondBody = Buffer.from(JSON.stringify({ slot: '0', descriptor: second }));
      const secondHeaders = signHeaders(
        keyPair,
        'POST',
        '/reconcile',
        secondBody,
        Math.floor(Date.now() / 1000)
      );
      const secondRes = await fetch(`${baseUrl}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...secondHeaders },
        body: secondBody,
      });
      // The swap: deployed into "b" (the fake Ghost this test stood up),
      // verified directly (real HTTP, real dist/server.js), then "b"
      // becomes the recorded live colour.
      expect(secondRes.status).toBe(200);
      expect(await secondRes.json()).toEqual({ slot: '0', phase: 'running', colour: 'b' });

      const statusRes = await fetch(`${baseUrl}/status/0`);
      expect(await statusRes.json()).toMatchObject({ slot: '0', phase: 'running' });
    } finally {
      await new Promise<void>((resolve) => fakeGhost.close(() => resolve()));
    }
  });

  // End to end through the real spawned entrypoint: a process died right
  // after a colour swap safely reached its target, before its own final
  // `writeSlotState` ran. Recovery must adopt the target, and a retried
  // /reconcile must hit the idempotent branch rather than believing the
  // stale source is still live. See server.test.md#crash-after-swap-recovery.
  it('recovers a crash right after a swap reached its target, and a retried reconcile never re-drains anything', async () => {
    const { env, keyPair, stateDir, drainFlagDir } = await baseEnv();
    const second = demoDescriptor({ ownerEmail: 'second@example.com' as never });
    const hash = descriptorHash(second);
    const newHashId = hashIdOf((second.gate as { argon2idHash: string }).argon2idHash);

    // The exact reality a crash right there leaves: colour "a" (the
    // source) drained, colour "b" (the target) clear -- a real listener
    // stands in for "b"'s own Ghost, already healthy.
    const targetGhostPort = 9301;
    const fakeGhost: Server = createServer((_req, res) => res.writeHead(200).end('ok'));
    await new Promise<void>((resolve) => fakeGhost.listen(targetGhostPort, '127.0.0.1', resolve));
    await writeFile(join(drainFlagDir, '0-a.drain'), '');
    await writeSlotState(
      stateDir,
      '0' as never,
      {
        phase: 'swapping',
        colour: 'a',
        swapTarget: 'b',
        swapDescriptorHash: hash,
        swapHashId: newHashId,
      } as never
    );

    try {
      const root = await makeTempDir('broker-plugin-');
      const renderer = await writeValidRendererPlugin(root);
      const adminApi = await writeValidAdminApiPlugin(root);
      const drainSource = await writeValidDrainSourcePlugin(root);
      const imageLoader = await writeValidImageLoaderPlugin(root);
      broker = spawnBroker({
        ...env,
        BROKER_RENDERER_MODULE: renderer,
        BROKER_ADMIN_API_MODULE: adminApi,
        BROKER_DRAIN_SOURCE_MODULE: drainSource,
        BROKER_IMAGE_LOADER_MODULE: imageLoader,
      });
      const { port } = await broker.waitListening(8000);
      const baseUrl = `http://127.0.0.1:${port}`;
      await new Promise((resolve) => setTimeout(resolve, 1100)); // past the same-second replay floor

      // Recovered before this process ever answered a single request.
      const statusAfterBoot = await fetch(`${baseUrl}/status/0`);
      expect(await statusAfterBoot.json()).toMatchObject({ slot: '0', phase: 'running' });

      const body = Buffer.from(JSON.stringify({ slot: '0', descriptor: second }));
      const headers = signHeaders(
        keyPair,
        'POST',
        '/reconcile',
        body,
        Math.floor(Date.now() / 1000)
      );
      const retryRes = await fetch(`${baseUrl}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      // The idempotent branch, not a fresh swap: recovery already gave
      // this slot the correct descriptorHash, so the retry does nothing
      // further -- in particular, it never touches colour "a"'s flag
      // again (which is exactly what a stale "colour: a is still live"
      // belief would have done, per the review's own scenario).
      expect(retryRes.status).toBe(200);
      expect(await retryRes.json()).toEqual({ slot: '0', phase: 'running', colour: 'b' });

      // Untouched by the retry: "a" still drained, "b" still clear --
      // never both drained at once, which is the outage this fix exists
      // to prevent.
      await expect(readFile(join(drainFlagDir, '0-a.drain'))).resolves.toBeDefined();
      await expect(readFile(join(drainFlagDir, '0-b.drain'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await new Promise<void>((resolve) => fakeGhost.close(() => resolve()));
    }
  });

  // --- Item 4: a slot left "preparing" by a process whose lock holder
  // died is recovered at boot, before this process ever listens. ---
  it('recovers a slot left "preparing" by a dead process: /status reads "error", one /reset then frees it', async () => {
    const root = await makeTempDir('broker-plugin-');
    const { env, keyPair, stateDir } = await baseEnv();
    // The exact shape a crash mid-`/reconcile` leaves: the per-slot lock
    // was in that dead process's memory, so nothing here can still be
    // holding it.
    await writeFile(join(stateDir, '2.json'), JSON.stringify({ phase: 'preparing' }));

    const renderer = await writeValidRendererPlugin(root);
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    const imageLoader = await writeValidImageLoaderPlugin(root);
    broker = spawnBroker({
      ...env,
      BROKER_RENDERER_MODULE: renderer,
      BROKER_ADMIN_API_MODULE: adminApi,
      BROKER_DRAIN_SOURCE_MODULE: drainSource,
      BROKER_IMAGE_LOADER_MODULE: imageLoader,
    });
    const { port } = await broker.waitListening(8000);
    const baseUrl = `http://127.0.0.1:${port}`;

    // Recovered, not left looking like a live in-flight reconcile.
    const statusRes = await fetch(`${baseUrl}/status/2`);
    expect(await statusRes.json()).toEqual({
      slot: '2',
      phase: 'error',
      healthy: false,
      notReal: ['adminApi', 'drainSource', 'imageLoader', 'renderer'],
      interim: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 1100)); // past item 2's same-second floor

    const body = Buffer.from(JSON.stringify({ slot: '2' }));
    const headers = signHeaders(keyPair, 'POST', '/reset', body, Math.floor(Date.now() / 1000));
    const resetRes = await fetch(`${baseUrl}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(resetRes.status).toBe(200);

    const statusAfterReset = await fetch(`${baseUrl}/status/2`);
    expect(await statusAfterReset.json()).toEqual({
      slot: '2',
      phase: 'free',
      healthy: false,
      notReal: ['adminApi', 'drainSource', 'imageLoader', 'renderer'],
      interim: [],
    });
  });

  // --- A slot recovered from "resetting" must also have the previous
  // tenancy's lease and hash revoked at boot, not just its phase marked
  // -- otherwise a crash between /reset's own writeSlotState('resetting')
  // and clearLeaseAndHash leaves that access live until an operator
  // happens to call /reset again. ---
  it('revokes a stale lease/hash for a slot recovered from "resetting", before this process ever listens', async () => {
    const root = await makeTempDir('broker-plugin-');
    const { env, stateDir, leaseDir, slotsPath } = await baseEnv();
    // The exact shape a crash between /reset's own two steps leaves: the
    // phase already says "resetting", but the previous tenancy's lease and
    // hash are still exactly as `/reconcile` wrote them.
    await writeLeaseAndHash(
      { slotsPath, leaseDir, nowMs: () => Date.now() },
      'stale-visitor.demo-domain.example.test',
      '3' as never,
      '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'
    );
    await writeFile(join(stateDir, '3.json'), JSON.stringify({ phase: 'resetting' }));

    const renderer = await writeValidRendererPlugin(root);
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    const imageLoader = await writeValidImageLoaderPlugin(root);
    broker = spawnBroker({
      ...env,
      BROKER_RENDERER_MODULE: renderer,
      BROKER_ADMIN_API_MODULE: adminApi,
      BROKER_DRAIN_SOURCE_MODULE: drainSource,
      BROKER_IMAGE_LOADER_MODULE: imageLoader,
    });
    await broker.waitListening(8000);

    const slots = JSON.parse(await readFile(slotsPath, 'utf8')) as { slots: { slot: string }[] };
    expect(slots.slots.find((e) => e.slot === '3')).toBeUndefined();
    await expect(readFile(join(leaseDir, '3.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
