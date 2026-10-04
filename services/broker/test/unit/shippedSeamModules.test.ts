import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailAddress } from '@branchleft/ghost-platform-render-core';
import type { AdminApiClient } from '../../src/adminApi.js';
import { makeTempDir } from '../../src/atomicFile.js';
import type { BrokerConfig } from '../../src/config.js';
import refusingAdminApi, { ADMIN_API_REFUSAL } from '../../src/plugins/refusingAdminApi.js';
import refusingDrainSource, { DRAIN_REFUSAL } from '../../src/plugins/refusingDrainSource.js';
import { buildDeps, loadPlugin } from '../../src/server.js';
import renderCorePlugin from '../../src/plugins/renderCorePlugin.js';
import dockerImageLoader from '../../src/plugins/dockerImageLoader.js';
import { seamReadiness } from '../../src/seamReadiness.js';
import { demoDescriptor, TEST_ZONES } from '../helpers/fixtures.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

const SERVICE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENV_EXAMPLE = join(SERVICE_ROOT, 'systemd/broker.env.example');
const BUNDLE_SCRIPT = join(SERVICE_ROOT, 'esbuild.bundle.mjs');
const FIXTURES = join(SERVICE_ROOT, 'test/live/fixtures/systemd-boot');

const SEAM_VARS = [
  'BROKER_RENDERER_MODULE',
  'BROKER_ADMIN_API_MODULE',
  'BROKER_DRAIN_SOURCE_MODULE',
  'BROKER_IMAGE_LOADER_MODULE',
];

function envValue(text: string, name: string): string | undefined {
  return new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1];
}

describe('the shipped drain source refuses openly', () => {
  it('rejects every poll with the reason, at once, never resolving an empty payload', async () => {
    const controller = new AbortController();
    await expect(refusingDrainSource.poll(controller.signal)).rejects.toThrow(DRAIN_REFUSAL);
    expect(DRAIN_REFUSAL).toBe(
      'mail is collected from the mail queue directly; nothing is handed over here'
    );
  });

  describe('through the real handler', () => {
    let broker: TestBroker | undefined;
    afterEach(async () => {
      await broker?.close();
      broker = undefined;
    });

    it('GET /drain answers 502 immediately and the journal names why', async () => {
      const logged: string[] = [];
      broker = await startTestBroker({
        wrapDeps: (deps) => ({
          ...deps,
          drainSource: refusingDrainSource,
          drainPollTimeoutMs: 10_000,
          log: (line) => logged.push(line),
        }),
      });
      const start = Date.now();
      const res = await broker.signedFetch('GET', '/drain');
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'drain source unavailable' });
      // A ten-second long-poll deadline: an answer far inside it proves the
      // refusal is not a timed-out empty poll.
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(logged.some((line) => line.includes(DRAIN_REFUSAL))).toBe(true);
    });
  });
});

describe('the interim admin client refuses every build', () => {
  it('rejects configure with the reason', async () => {
    await expect(
      refusingAdminApi.configure('http://127.0.0.1:9300', demoDescriptor())
    ).rejects.toThrow(ADMIN_API_REFUSAL);
  });

  describe('through the real handler', () => {
    let broker: TestBroker | undefined;
    afterEach(async () => {
      await broker?.close();
      broker = undefined;
    });

    it('a fresh build ends in error, writes no lease, and logs the refusal', async () => {
      const logged: string[] = [];
      broker = await startTestBroker({
        wrapDeps: (deps) => ({
          ...deps,
          adminApi: refusingAdminApi,
          log: (line) => logged.push(line),
        }),
      });
      const descriptor = demoDescriptor();
      const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ slot: '0', phase: 'error' });

      const slots = await readFile(broker.slotsPath, 'utf8').catch(() => '{"slots":[]}');
      expect(slots).not.toContain(new URL(descriptor.siteUrl).hostname);
      expect(logged.some((line) => line.includes(ADMIN_API_REFUSAL))).toBe(true);
    });

    it('a colour swap is refused and the slot stays on its current colour', async () => {
      // Built with a working client, then the client swapped for the
      // refusing one: the shape of a host upgraded onto the interim module.
      let current: AdminApiClient = { configure: async () => undefined };
      broker = await startTestBroker({
        wrapDeps: (deps) => ({
          ...deps,
          adminApi: { configure: (url, d) => current.configure(url, d) },
        }),
      });
      const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
      const built = await broker.signedFetch('POST', '/reconcile', {
        slot: '0',
        descriptor: first,
      });
      expect(built.status).toBe(200);

      current = refusingAdminApi;
      const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });
      const res = await broker.signedFetch('POST', '/reconcile', { slot: '0', descriptor: second });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        slot: '0',
        phase: 'running',
        colour: 'a',
        error: ADMIN_API_REFUSAL,
      });
      const status = await fetch(`${broker.baseUrl}/status/0`);
      expect(await status.json()).toMatchObject({ phase: 'running' });
    });
  });
});

describe('seamReadiness fails closed', () => {
  it('a module with no markers at all is reported as not real', () => {
    expect(seamReadiness({ adminApi: { configure: () => undefined } })).toEqual({
      notReal: ['adminApi'],
      interim: [],
    });
  });

  it('only exactly `real: true` counts as real; anything else is listed, sorted', () => {
    expect(
      seamReadiness({
        renderer: { real: true },
        drainSource: { real: 'true' },
        imageLoader: { real: 1 },
        adminApi: { real: false },
      }).notReal
    ).toEqual(['adminApi', 'drainSource', 'imageLoader']);
  });

  it('lists an interim module even when it also claims to be real', () => {
    expect(seamReadiness({ adminApi: { real: true, interim: true } })).toEqual({
      notReal: [],
      interim: ['adminApi'],
    });
    expect(seamReadiness({ adminApi: { interim: 'yes' } }).interim).toEqual(['adminApi']);
  });

  it('treats a seam that is not an object as not real', () => {
    expect(seamReadiness({ a: null, b: undefined, c: 3 })).toEqual({
      notReal: ['a', 'b', 'c'],
      interim: [],
    });
  });
});

function fakeConfig(): BrokerConfig {
  const dir = '/tmp/does-not-matter-for-buildDeps';
  return {
    port: 0,
    host: '127.0.0.1',
    slotsPath: `${dir}/slots.json`,
    leaseDir: `${dir}/lease`,
    stateDir: `${dir}/state`,
    drainFlagDir: `${dir}/drain`,
    slotDirBase: `${dir}/slots`,
    imageTmpDir: `${dir}/image-tmp`,
    imageMaxBytes: 1024,
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
  };
}

describe('stand-ins are reported, the shipped modules carry their markers', () => {
  it('loading both boot-proof stand-ins reports both as not real', async () => {
    const env = {
      BROKER_ADMIN_API_MODULE: join(FIXTURES, 'noop-admin-api.mjs'),
      BROKER_DRAIN_SOURCE_MODULE: join(FIXTURES, 'noop-drain-source.mjs'),
    };
    const adminApi = await loadPlugin(
      'BROKER_ADMIN_API_MODULE',
      env,
      (c): c is AdminApiClient => typeof (c as AdminApiClient).configure === 'function'
    );
    const drainSource = await loadPlugin(
      'BROKER_DRAIN_SOURCE_MODULE',
      env,
      (c): c is typeof refusingDrainSource =>
        typeof (c as typeof refusingDrainSource).poll === 'function'
    );
    const deps = buildDeps(
      fakeConfig(),
      renderCorePlugin,
      adminApi,
      drainSource,
      dockerImageLoader
    );
    expect(deps.seamReadiness).toEqual({ notReal: ['adminApi', 'drainSource'], interim: [] });
  });

  it('the shipped set reports only the interim admin client', () => {
    const deps = buildDeps(
      fakeConfig(),
      renderCorePlugin,
      refusingAdminApi,
      refusingDrainSource,
      dockerImageLoader
    );
    expect(deps.seamReadiness).toEqual({ notReal: ['adminApi'], interim: ['adminApi'] });
  });

  describe('through the real handler', () => {
    let broker: TestBroker | undefined;
    afterEach(async () => {
      await broker?.close();
      broker = undefined;
    });

    it('/status carries both lists', async () => {
      broker = await startTestBroker({
        wrapDeps: (deps) => ({
          ...deps,
          seamReadiness: { notReal: ['adminApi'], interim: ['adminApi'] },
        }),
      });
      const res = await fetch(`${broker.baseUrl}/status/0`);
      expect(await res.json()).toEqual({
        slot: '0',
        phase: 'free',
        healthy: false,
        notReal: ['adminApi'],
        interim: ['adminApi'],
      });
    });
  });
});

describe('the shipped env template names only modules the bundle builds', () => {
  it('every seam variable points at a plugin esbuild.bundle.mjs produces', async () => {
    const [envText, bundleScript] = await Promise.all([
      readFile(ENV_EXAMPLE, 'utf8'),
      readFile(BUNDLE_SCRIPT, 'utf8'),
    ]);
    for (const name of SEAM_VARS) {
      const value = envValue(envText, name);
      expect(value, name).toMatch(/^\/opt\/branchleft\/broker\/current\/plugins\/[A-Za-z]+\.mjs$/);
      const file = (value ?? '').split('/').pop() ?? '';
      expect(bundleScript, `${name} -> ${file}`).toContain(`dist/bundle/plugins/${file}`);
    }
  });

  it('names the refusing modules, never a placeholder or a test stand-in', async () => {
    const envText = await readFile(ENV_EXAMPLE, 'utf8');
    expect(envValue(envText, 'BROKER_ADMIN_API_MODULE')).toMatch(/\/refusingAdminApi\.mjs$/);
    expect(envValue(envText, 'BROKER_DRAIN_SOURCE_MODULE')).toMatch(/\/refusingDrainSource\.mjs$/);
    expect(envText).not.toMatch(/^BROKER_\w+_MODULE=.*(REPLACE-ME|noop-)/m);
  });

  it('the boot proof installs the shipped template, not a fixture env file', async () => {
    const dockerfile = await readFile(join(FIXTURES, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      'COPY services/broker/systemd/broker.env.example /etc/branchleft/broker.env'
    );
    expect(dockerfile).not.toMatch(/COPY [^\n]*noop-/);
  });
});

describe('loadPlugin and a hand-written module', () => {
  it('an unmarked module written to disk is reported as not real once loaded', async () => {
    const dir = await makeTempDir('broker-unmarked-');
    const path = join(dir, 'admin.mjs');
    await writeFile(path, 'export default { async configure() {} };\n');
    const mod = await loadPlugin(
      'BROKER_ADMIN_API_MODULE',
      { BROKER_ADMIN_API_MODULE: path },
      (c): c is AdminApiClient => typeof (c as AdminApiClient).configure === 'function'
    );
    expect(seamReadiness({ adminApi: mod }).notReal).toEqual(['adminApi']);
  });
});

describe('the shipped env template uses the demo host paths', () => {
  it('keeps the slots file in the broker-owned directory, not its root-owned parent', async () => {
    const envText = await readFile(ENV_EXAMPLE, 'utf8');
    expect(envValue(envText, 'BROKER_SLOTS_FILE')).toBe(
      '/var/lib/branchleft/broker-slots/slots.json'
    );
  });
});
