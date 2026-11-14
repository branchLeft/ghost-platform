import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DescriptorTargetStore } from '../../src/descriptorTargets.js';
import { createLogger } from '../../src/log.js';

const TENANT_IDENTITY = { kind: 'tenant', domain: 'tenant-a.example', dkimSelector: 'sel' };

describe('the sending domain a drain target carries', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-sending-domain-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function targetsOf(descriptor: Record<string, unknown>, demoMailDomain?: string) {
    writeFileSync(
      join(dir, 'host.json'),
      JSON.stringify({ slug: 'host-a', appHostIp: '127.0.0.1', expiresAt: null, ...descriptor })
    );
    const store = new DescriptorTargetStore({
      descriptorDir: dir,
      shimScheme: 'http',
      shimPort: 8080,
      maxStalenessMs: 60_000,
      log: createLogger(() => {}),
      ...(demoMailDomain === undefined ? {} : { demoMailDomain }),
    });
    await store.refresh();
    return store.targets;
  }

  it("is a tenant descriptor's own sending domain", async () => {
    const [target] = await targetsOf({ kind: 'tenant', mail: { identity: TENANT_IDENTITY } });
    expect(target?.sendingDomain).toBe('tenant-a.example');
  });

  it("is never the configured demo domain for a tenant: a tenant with no identity is refused, not given the demo's", async () => {
    expect(await targetsOf({ kind: 'tenant' }, 'demo.example')).toEqual([]);
  });

  it('is the configured demo mail domain for a demo, with or without an identity block', async () => {
    const [bare] = await targetsOf({ kind: 'demo' }, 'demo.example');
    expect(bare?.sendingDomain).toBe('demo.example');
    const [withIdentity] = await targetsOf(
      { kind: 'demo', mail: { identity: { kind: 'demo', localPart: 'hello' } } },
      'demo.example'
    );
    expect(withIdentity?.sendingDomain).toBe('demo.example');
  });

  it("is never a tenant's domain on a demo descriptor", async () => {
    const [target] = await targetsOf(
      { kind: 'demo', mail: { identity: TENANT_IDENTITY } },
      'demo.example'
    );
    expect(target?.sendingDomain).toBeUndefined();
  });

  it('is absent for a demo when no demo mail domain is configured', async () => {
    const [target] = await targetsOf({ kind: 'demo' });
    expect(target).toBeDefined();
    expect(target?.sendingDomain).toBeUndefined();
  });
});

describe('COLLECTOR_DEMO_MAIL_DOMAIN', () => {
  const BASE_ENV = {
    COLLECTOR_DESCRIPTOR_DIR: '/tmp/descriptors',
    COLLECTOR_DRAIN_TOKEN: 'token',
    COLLECTOR_SMTP_HOST: 'mx1.example.internal',
    COLLECTOR_SMTP_USER: 'collector',
    COLLECTOR_SMTP_PASS: 'secret',
    COLLECTOR_HEARTBEAT_URL: 'https://heartbeat.example/ping',
  };

  it('is unset by default, and empty counts as unset', () => {
    expect(loadConfig(BASE_ENV).demoMailDomain).toBeUndefined();
    expect(
      loadConfig({ ...BASE_ENV, COLLECTOR_DEMO_MAIL_DOMAIN: '' }).demoMailDomain
    ).toBeUndefined();
  });

  it('is read as given', () => {
    expect(
      loadConfig({ ...BASE_ENV, COLLECTOR_DEMO_MAIL_DOMAIN: 'demo.example' }).demoMailDomain
    ).toBe('demo.example');
  });
});

describe('a tenant descriptor with no sendable identity is refused loudly, never held silently', () => {
  let dir: string;
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'collector-identity-refused-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function drainTargets(descriptors: Record<string, Record<string, unknown>>) {
    for (const [slug, descriptor] of Object.entries(descriptors)) {
      writeFileSync(
        join(dir, `${slug}.json`),
        JSON.stringify({ slug, appHostIp: '127.0.0.1', expiresAt: null, ...descriptor })
      );
    }
    const store = new DescriptorTargetStore({
      descriptorDir: dir,
      shimScheme: 'http',
      shimPort: 8080,
      maxStalenessMs: 60_000,
      log: createLogger((line) => lines.push(line)),
    });
    await store.refresh();
    return store;
  }

  const logged = () =>
    lines.map((line) => JSON.parse(line) as { level: string; event: string; fields: unknown });

  it('drains no host for a tenant whose descriptor has no mail.identity, and logs an error naming the file and slug', async () => {
    const store = await drainTargets({ 'tenant-a': { kind: 'tenant' } });
    expect(store.targets).toEqual([]);
    expect(logged()).toEqual([
      expect.objectContaining({
        level: 'error',
        event: 'descriptor_tenant_identity_missing',
        fields: { file: 'tenant-a.json', slug: 'tenant-a' },
      }),
    ]);
  });

  it.each([
    ['a demo identity', { kind: 'demo', localPart: 'hello' }],
    ['no domain', { kind: 'tenant' }],
    ['an empty domain', { kind: 'tenant', domain: '' }],
    ['a non-string domain', { kind: 'tenant', domain: 42 }],
    ['a domain that is not a hostname', { kind: 'tenant', domain: 'not a host' }],
    ['a bare string', 'tenant-a.example'],
    ['null', null],
  ])('drains no host for a tenant whose identity is %s', async (_label, identity) => {
    const store = await drainTargets({ 'tenant-a': { kind: 'tenant', mail: { identity } } });
    expect(store.targets).toEqual([]);
    expect(logged().map((entry) => entry.event)).toEqual(['descriptor_tenant_identity_missing']);
  });

  it('refuses only the tenant with no identity: a sendable tenant beside it is still drained', async () => {
    const store = await drainTargets({
      'tenant-a': { kind: 'tenant', mail: { identity: TENANT_IDENTITY } },
      'tenant-b': { kind: 'tenant' },
    });
    expect(store.targets.map((t) => [t.id, t.sendingDomain])).toEqual([
      ['tenant-a', 'tenant-a.example'],
    ]);
    expect(logged().map((entry) => entry.fields)).toEqual([
      { file: 'tenant-b.json', slug: 'tenant-b' },
    ]);
  });

  it('says nothing for an expired tenant descriptor that has no identity', async () => {
    const store = await drainTargets({
      'tenant-a': { kind: 'tenant', expiresAt: '2000-01-01T00:00:00Z' },
    });
    expect(store.targets).toEqual([]);
    expect(logged()).toEqual([]);
  });

  it('does not refuse a demo for having no identity block', async () => {
    const store = await drainTargets({ 'demo-a': { kind: 'demo' } });
    expect(store.targets.map((t) => t.id)).toEqual(['demo-a']);
    expect(logged()).toEqual([]);
  });
});
