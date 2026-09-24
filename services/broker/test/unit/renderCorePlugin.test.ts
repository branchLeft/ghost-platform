import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { demoDescriptor, TEST_ZONES } from '../helpers/fixtures.js';
import { generateTestKeyPair, signHeaders } from '../helpers/signer.js';
import {
  writeValidAdminApiPlugin,
  writeValidDrainSourcePlugin,
  writeValidRendererPlugin,
} from '../helpers/pluginFixtures.js';
import { findFreePort, spawnBroker, type SpawnedBroker } from '../helpers/spawnBroker.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = join(here, '..', '..');
const REAL_PLUGIN_DIST = join(SERVICE_ROOT, 'dist', 'plugins', 'renderCorePlugin.js');

describe('renderCorePlugin — the adapter itself', () => {
  it('is a valid default-exported Renderer, and its render() matches render-core directly', async () => {
    process.env.BROKER_DEMO_ZONE = TEST_ZONES.demoZone;
    process.env.BROKER_PLATFORM_ZONE = TEST_ZONES.platformZone;
    process.env.BROKER_OWNED_DOMAINS = TEST_ZONES.ownedDomains.join(',');
    const mod = (await import('../../src/plugins/renderCorePlugin.js')) as {
      default: { render: (d: unknown) => Promise<readonly { path: string; content: string }[]> };
    };
    const descriptor = demoDescriptor();
    const viaPlugin = await mod.default.render(descriptor);
    const viaDirect = render(descriptor, TEST_ZONES);
    expect(viaPlugin).toEqual(viaDirect);
    expect(viaPlugin.map((a) => a.path)).toEqual([
      'compose.yml',
      'secrets.env',
      'image.env',
      'provision.sh',
      'edge.json',
      'ghost-settings.json',
      'identity.json',
    ]);
  });

  it('refuses to render when a zone env var is missing, naming it', async () => {
    delete process.env.BROKER_DEMO_ZONE;
    process.env.BROKER_PLATFORM_ZONE = TEST_ZONES.platformZone;
    process.env.BROKER_OWNED_DOMAINS = TEST_ZONES.ownedDomains.join(',');
    // Fresh module instance per test would need a registry reset; instead
    // this asserts the exported function's own env read, which is what
    // `zonesFromEnv` actually is — re-imported modules are cached by
    // Node's ESM loader, so this exercises the same closure the already-
    // imported instance above uses, with the env var now absent.
    const mod = (await import('../../src/plugins/renderCorePlugin.js')) as {
      default: { render: (d: unknown) => Promise<unknown> };
    };
    await expect(mod.default.render(demoDescriptor())).rejects.toThrow(/BROKER_DEMO_ZONE/);
    process.env.BROKER_DEMO_ZONE = TEST_ZONES.demoZone;
  });
});

/**
 * The story's own control requirement (common-rules.md item 17): a test
 * through the real entry point, not the module in isolation. Spawns the
 * actual built `dist/server.js`, with the actual built
 * `dist/plugins/renderCorePlugin.js` wired in via `BROKER_RENDERER_MODULE`
 * exactly as a real deploy would set it, and reads back the artefacts
 * `/reconcile` actually wrote to disk.
 */
describe('the real broker dist, wired to the real render-core plugin', () => {
  let broker: SpawnedBroker | undefined;

  afterEach(() => {
    broker?.stop();
    broker = undefined;
  });

  async function baseEnv(): Promise<{
    env: Record<string, string>;
    keyPair: ReturnType<typeof generateTestKeyPair>;
    slotDirBase: string;
  }> {
    const root = await makeTempDir('render-core-plugin-spawn-');
    const keyPair = generateTestKeyPair();
    const keyPath = join(root, 'verify.key');
    await writeFile(keyPath, keyPair.publicKeyRaw);
    const stateDir = join(root, 'state');
    const leaseDir = join(root, 'lease');
    const drainFlagDir = join(root, 'drain');
    const slotDirBase = join(root, 'slots');
    const slotsPath = join(root, 'slots.json');
    await mkdir(stateDir, { recursive: true });
    await mkdir(leaseDir, { recursive: true });
    await mkdir(drainFlagDir, { recursive: true });
    await mkdir(slotDirBase, { recursive: true });
    return {
      keyPair,
      slotDirBase,
      env: {
        PORT: String(await findFreePort()),
        LISTEN_HOST: '127.0.0.1',
        BROKER_VERIFY_KEY_FILE: keyPath,
        BROKER_SLOTS_FILE: slotsPath,
        BROKER_LEASE_DIR: leaseDir,
        BROKER_STATE_DIR: stateDir,
        BROKER_DRAIN_FLAG_DIR: drainFlagDir,
        BROKER_SLOT_DIR_BASE: slotDirBase,
        BROKER_DEMO_ZONE: TEST_ZONES.demoZone,
        BROKER_PLATFORM_ZONE: TEST_ZONES.platformZone,
        BROKER_OWNED_DOMAINS: TEST_ZONES.ownedDomains.join(','),
        BROKER_WRAPPER_COMMAND: join(SERVICE_ROOT, 'test/helpers/fakeWrapper.mjs'),
        BROKER_WRAPPER_PREFIX: process.execPath,
        BROKER_SLOT_LITERALS: '0,1,2,3,4,5,6',
      },
    };
  }

  async function reconcile(
    baseUrl: string,
    keyPair: ReturnType<typeof generateTestKeyPair>
  ): Promise<Response> {
    const body = Buffer.from(JSON.stringify({ slot: '0', descriptor: demoDescriptor() }));
    const headers = signHeaders(keyPair, 'POST', '/reconcile', body, Math.floor(Date.now() / 1000));
    return fetch(`${baseUrl}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  }

  it('GREEN — /reconcile writes all seven real render-core artefacts to the slot directory', async () => {
    const root = await makeTempDir('render-core-plugin-');
    const { env, keyPair, slotDirBase } = await baseEnv();
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    broker = spawnBroker({
      ...env,
      BROKER_RENDERER_MODULE: REAL_PLUGIN_DIST,
      BROKER_ADMIN_API_MODULE: adminApi,
      BROKER_DRAIN_SOURCE_MODULE: drainSource,
    });
    const { port } = await broker.waitListening(8000);
    // Past item 2's same-second floor (see server.test.ts's own comment).
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const res = await reconcile(`http://127.0.0.1:${port}`, keyPair);
    expect(res.status).toBe(200);

    const slotDir = join(slotDirBase, '0');
    const compose = await readFile(join(slotDir, 'compose.yml'), 'utf8');
    const identity = JSON.parse(await readFile(join(slotDir, 'identity.json'), 'utf8')) as {
      slug: string;
      uid: number;
    };
    const edge = JSON.parse(await readFile(join(slotDir, 'edge.json'), 'utf8')) as {
      admittedHostname: string | null;
    };

    // The real renderer's output, not the fake fixture's ('ghost.env'
    // containing 'NODE_ENV=production') — see the RED case below for the
    // contrast this proves.
    expect(compose).toContain('ghost-a:');
    expect(compose).toContain('ghost-b:');
    expect(identity.slug).toBe('demo-1');
    expect(identity.uid).toBe(30001);
    // The demo/public-hostname invariant, proven through the real HTTP
    // path rather than only against the module directly (render.test.ts
    // in render-core already proves it in isolation).
    expect(edge.admittedHostname).toBeNull();
  });

  it('RED — sabotage: disconnecting the real plugin (the generic fixture stand-in instead) writes none of the seven real artefacts', async () => {
    // This is the wiring sabotage common-rules.md item 17 asks for: the
    // call site (BROKER_RENDERER_MODULE) pointed at something that is NOT
    // render-core's own render(), to show the proof above actually
    // depends on the real wiring rather than passing regardless of what a
    // Renderer plugin does.
    const root = await makeTempDir('render-core-plugin-disconnected-');
    const { env, keyPair, slotDirBase } = await baseEnv();
    const genericRenderer = await writeValidRendererPlugin(root);
    const adminApi = await writeValidAdminApiPlugin(root);
    const drainSource = await writeValidDrainSourcePlugin(root);
    broker = spawnBroker({
      ...env,
      BROKER_RENDERER_MODULE: genericRenderer,
      BROKER_ADMIN_API_MODULE: adminApi,
      BROKER_DRAIN_SOURCE_MODULE: drainSource,
    });
    const { port } = await broker.waitListening(8000);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const res = await reconcile(`http://127.0.0.1:${port}`, keyPair);
    expect(res.status).toBe(200);

    const slotDir = join(slotDirBase, '0');
    // The generic fixture's own, single, trivial artefact — proving the
    // disconnected state is distinguishable from the real wiring above,
    // not merely "some file got written".
    const written = await readFile(join(slotDir, 'ghost.env'), 'utf8');
    expect(written).toBe('NODE_ENV=production\n');
    await expect(readFile(join(slotDir, 'compose.yml'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(slotDir, 'identity.json'), 'utf8')).rejects.toThrow();
  });
});
