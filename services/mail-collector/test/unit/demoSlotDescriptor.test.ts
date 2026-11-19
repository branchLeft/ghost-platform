import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DescriptorTargetStore, normalizeRecipient } from '../../src/descriptorTargets.js';
import { createLogger } from '../../src/log.js';

const DEMO_IDENTITY = { kind: 'demo', localPart: 'slot-one' };

describe('what a demo descriptor tells the collector about its own slot', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-demo-slot-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function targetOf(descriptor: Record<string, unknown>) {
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
      demoMailDomain: 'demo.example',
    });
    await store.refresh();
    return store.targets[0];
  }

  it("carries the slot's own local part, owner address and ceiling", async () => {
    const target = await targetOf({
      kind: 'demo',
      ownerEmail: 'Prospect@Example.COM',
      mail: { identity: DEMO_IDENTITY, ceiling: 7, estateCeiling: 500 },
    });
    expect(target).toMatchObject({
      demo: true,
      senderLocalPart: 'slot-one',
      ownerEmail: 'prospect@example.com',
      mailCeiling: 7,
    });
  });

  it('carries a ceiling of zero: no mail at all', async () => {
    const target = await targetOf({ kind: 'demo', mail: { identity: DEMO_IDENTITY, ceiling: 0 } });
    expect(target?.mailCeiling).toBe(0);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '5'],
    ['null', null],
  ])('ignores a ceiling that is %s, so the collector default applies', async (_label, ceiling) => {
    const target = await targetOf({ kind: 'demo', mail: { identity: DEMO_IDENTITY, ceiling } });
    expect(target).toBeDefined();
    expect(target).not.toHaveProperty('mailCeiling');
  });

  it.each([
    ['one with an @', 'a@b'],
    ['one with a slash', 'a/b'],
    ['one that starts with a dot', '.a'],
    ['an empty one', ''],
    ['a number', 7],
    ['one over 64 characters', 'a'.repeat(65)],
  ])('gives a demo with %s no local part, so its mail is held', async (_label, localPart) => {
    const target = await targetOf({
      kind: 'demo',
      mail: { identity: { kind: 'demo', localPart } },
    });
    expect(target).toBeDefined();
    expect(target).not.toHaveProperty('senderLocalPart');
  });

  it("gives a demo whose identity is a tenant's no local part", async () => {
    const target = await targetOf({
      kind: 'demo',
      mail: { identity: { kind: 'tenant', domain: 'x.example', dkimSelector: 's' } },
    });
    expect(target).not.toHaveProperty('senderLocalPart');
  });

  it.each([
    ['missing', undefined],
    ['a list', 'a@example.com, b@example.org'],
    ['a display name', 'A <a@example.com>'],
    ['not an address', 'nobody'],
    ['a number', 5],
  ])('gives a demo whose owner address is %s no recipient at all', async (_label, ownerEmail) => {
    const target = await targetOf({
      kind: 'demo',
      ...(ownerEmail === undefined ? {} : { ownerEmail }),
      mail: { identity: DEMO_IDENTITY },
    });
    expect(target).toBeDefined();
    expect(target).not.toHaveProperty('ownerEmail');
  });

  it("never reads these from a tenant's descriptor", async () => {
    const target = await targetOf({
      kind: 'tenant',
      ownerEmail: 'owner@example.com',
      mail: {
        identity: { kind: 'tenant', domain: 'tenant-a.example', dkimSelector: 'sel' },
        ceiling: 3,
      },
    });
    expect(target).toBeDefined();
    expect(target).not.toHaveProperty('senderLocalPart');
    expect(target).not.toHaveProperty('ownerEmail');
    expect(target).not.toHaveProperty('mailCeiling');
  });
});

describe('the recipient spelling the collector compares', () => {
  it('lower-cases one plain mailbox', () => {
    expect(normalizeRecipient('Person@Example.COM')).toBe('person@example.com');
  });

  it.each([
    'a@b',
    '@example.com',
    'a@@example.com',
    'a@b@example.com',
    'a b@example.com',
    'a@example.com\n',
    'a@example.com,b@example.org',
    'a@example.com;b@example.org',
    '<a@example.com>',
    '"a"@example.com',
    'a@.com',
    'a@example.',
    '',
    `${'a'.repeat(250)}@e.example`,
  ])('refuses %j', (raw) => {
    expect(normalizeRecipient(raw)).toBeNull();
  });

  it('refuses a value that is not a string', () => {
    expect(normalizeRecipient(undefined)).toBeNull();
    expect(normalizeRecipient(['a@example.com'])).toBeNull();
  });
});

describe('the demo ceilings the collector is configured with', () => {
  const BASE = {
    COLLECTOR_DESCRIPTOR_DIR: '/d',
    COLLECTOR_DRAIN_TOKEN: 't',
    COLLECTOR_SMTP_HOST: 'mx1.example',
    COLLECTOR_SMTP_USER: 'u',
    COLLECTOR_SMTP_PASS: 'p',
    COLLECTOR_HEARTBEAT_URL: 'http://hc.example/ping',
  };

  it('has a small default per slot, a hard estate cap, and a day-long window', () => {
    expect(loadConfig(BASE).demoCeilings).toEqual({
      slotCeiling: 20,
      estateCeiling: 200,
      windowMs: 86_400_000,
      statePath: undefined,
    });
  });

  it('reads the three numbers from the environment', () => {
    expect(
      loadConfig({
        ...BASE,
        COLLECTOR_DEMO_SLOT_CEILING: '5',
        COLLECTOR_DEMO_ESTATE_CEILING: '50',
        COLLECTOR_DEMO_CEILING_WINDOW_MS: '3600000',
      }).demoCeilings
    ).toMatchObject({ slotCeiling: 5, estateCeiling: 50, windowMs: 3_600_000 });
  });

  it('keeps the counted places beside the dedupe file unless told otherwise', () => {
    expect(
      loadConfig({ ...BASE, COLLECTOR_DEDUPE_STATE_PATH: '/var/lib/collector/dedupe.json' })
        .demoCeilings.statePath
    ).toBe('/var/lib/collector/demo-ceilings.json');
    expect(
      loadConfig({
        ...BASE,
        COLLECTOR_DEDUPE_STATE_PATH: '/var/lib/collector/dedupe.json',
        COLLECTOR_DEMO_CEILING_STATE_PATH: '/elsewhere/ceilings.json',
      }).demoCeilings.statePath
    ).toBe('/elsewhere/ceilings.json');
  });
});
