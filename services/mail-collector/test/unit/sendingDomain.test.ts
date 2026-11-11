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

  it('is not the configured demo domain for a tenant, even one whose descriptor names none', async () => {
    const [target] = await targetsOf({ kind: 'tenant' }, 'demo.example');
    expect(target).toBeDefined();
    expect(target?.sendingDomain).toBeUndefined();
  });

  it('is absent for a tenant whose identity is a demo identity or is unreadable', async () => {
    for (const identity of [
      { kind: 'demo', localPart: 'hello' },
      { kind: 'tenant' },
      { kind: 'tenant', domain: '' },
      { kind: 'tenant', domain: 42 },
      'tenant-a.example',
      null,
    ]) {
      const [target] = await targetsOf({ kind: 'tenant', mail: { identity } }, 'demo.example');
      expect(target).toBeDefined();
      expect(target?.sendingDomain).toBeUndefined();
    }
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
