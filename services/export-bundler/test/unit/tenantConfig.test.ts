import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTenant,
  buildComposeConfigArgs,
  loadComposeConfig,
  mediaBaseUrlOf,
  parseComposeConfig,
  parseDescriptorFacts,
  RecipientMismatchError,
  SUPPORT_IDENTITY_ENV,
  TenantConfigError,
  type DescriptorFacts,
  type TenantRuntime,
} from '../../src/tenantConfig.js';

const RECIPIENT = 'age1' + 'q'.repeat(58);
const OTHER_RECIPIENT = 'age1' + 'p'.repeat(58);

function composeConfig(
  overrides: Record<string, unknown> = {},
  envOverrides: Record<string, unknown> = {}
) {
  return {
    name: 'acme',
    services: {
      'ghost-a': {
        image: 'ghost-platform@sha256:abc',
        user: '1001:1001',
        environment: {
          url: 'https://acme.example',
          database__connection__password: 'synthetic-pw',
          privacy__useUpdateCheck: 'false',
          adapters__sso__BreakGlassSSO__tenant: 'acme',
          [SUPPORT_IDENTITY_ENV]: 'support@acme.example',
          unset: null,
          ...envOverrides,
        },
        volumes: [
          { type: 'volume', source: 'ghost-acme-content', target: '/var/lib/ghost/content' },
          {
            type: 'volume',
            source: 'ghost-acme-adapters',
            target: '/var/lib/ghost/content/adapters',
            read_only: true,
          },
        ],
        ...overrides,
      },
    },
  };
}

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'acme',
    backup: { kind: 'bucket-native', encryptionRecipient: RECIPIENT },
    ...overrides,
  };
}

describe('parseComposeConfig', () => {
  it("takes the image, user, env, volumes and support identity from the tenant's colour a", () => {
    const runtime = parseComposeConfig(composeConfig());
    expect(runtime).toEqual({
      stackName: 'acme',
      image: 'ghost-platform@sha256:abc',
      user: '1001:1001',
      env: {
        url: 'https://acme.example',
        database__connection__password: 'synthetic-pw',
        privacy__useUpdateCheck: 'false',
        adapters__sso__BreakGlassSSO__tenant: 'acme',
        [SUPPORT_IDENTITY_ENV]: 'support@acme.example',
      },
      volumes: [
        { source: 'ghost-acme-content', target: '/var/lib/ghost/content', readOnly: false },
        {
          source: 'ghost-acme-adapters',
          target: '/var/lib/ghost/content/adapters',
          readOnly: true,
        },
      ],
      supportIdentity: 'support@acme.example',
    });
  });

  it('reads a missing user as null', () => {
    expect(parseComposeConfig(composeConfig({ user: undefined })).user).toBeNull();
  });

  it.each([
    ['not an object', 'x'],
    ['no name', { services: composeConfig().services }],
    ['no ghost-a service', { name: 'acme', services: {} }],
    ['no image', composeConfig({ image: undefined })],
    ['a bind mount', composeConfig({ volumes: [{ type: 'bind', source: '/', target: '/x' }] })],
    ['no volume at all', composeConfig({ volumes: [] })],
    ['no environment', composeConfig({ environment: undefined })],
    ['no support identity', composeConfig({}, { [SUPPORT_IDENTITY_ENV]: '' })],
  ])('refuses a stack with %s', (_label, config) => {
    expect(() => parseComposeConfig(config)).toThrow(TenantConfigError);
  });
});

describe('parseDescriptorFacts', () => {
  it('takes the slug and the backup recipient; the support identity is null until the descriptor carries one', () => {
    expect(parseDescriptorFacts(descriptor())).toEqual({
      slug: 'acme',
      ageRecipient: RECIPIENT,
      supportIdentity: null,
    });
  });

  it('takes breakGlass.supportIdentity when break-glass is enabled', () => {
    expect(
      parseDescriptorFacts(
        descriptor({ breakGlass: { kind: 'enabled', supportIdentity: 'support@acme.example' } })
      ).supportIdentity
    ).toBe('support@acme.example');
    expect(
      parseDescriptorFacts(descriptor({ breakGlass: { kind: 'disabled' } })).supportIdentity
    ).toBeNull();
  });

  it.each([
    ['not an object', null],
    ['no slug', { backup: descriptor().backup }],
    ['backup.kind none', descriptor({ backup: { kind: 'none' } })],
    ['no backup', descriptor({ backup: undefined })],
    [
      'a malformed recipient',
      descriptor({ backup: { kind: 'bucket-native', encryptionRecipient: 'age1nope' } }),
    ],
  ])('refuses a descriptor with %s', (_label, value) => {
    expect(() => parseDescriptorFacts(value)).toThrow(TenantConfigError);
  });
});

describe('bindTenant', () => {
  const facts: DescriptorFacts = { slug: 'acme', ageRecipient: RECIPIENT, supportIdentity: null };
  const runtime: TenantRuntime = parseComposeConfig(composeConfig());

  it("returns the descriptor's recipient when every source agrees", () => {
    expect(bindTenant(facts, runtime, RECIPIENT)).toBe(RECIPIENT);
  });

  it("refuses an operator recipient that is not the descriptor's -- RecipientMismatchError", () => {
    expect(() => bindTenant(facts, runtime, OTHER_RECIPIENT)).toThrow(RecipientMismatchError);
  });

  it("refuses a stack that is not the descriptor's tenant", () => {
    expect(() => bindTenant({ ...facts, slug: 'other' }, runtime, RECIPIENT)).toThrow(
      /compose stack is "acme", not the descriptor's "other"/
    );
  });

  it("refuses a break-glass tenant audience that is not the descriptor's slug", () => {
    const skewed = parseComposeConfig(
      composeConfig({}, { adapters__sso__BreakGlassSSO__tenant: 'other' })
    );
    expect(() => bindTenant(facts, skewed, RECIPIENT)).toThrow(TenantConfigError);
  });

  it("refuses a rendered support identity that is not the descriptor's", () => {
    expect(() =>
      bindTenant({ ...facts, supportIdentity: 'someone-else@acme.example' }, runtime, RECIPIENT)
    ).toThrow(/not the descriptor's breakGlass.supportIdentity/);
    expect(
      bindTenant({ ...facts, supportIdentity: 'support@acme.example' }, runtime, RECIPIENT)
    ).toBe(RECIPIENT);
  });
});

describe('loadComposeConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-compose-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fakeDocker(lines: readonly string[]): Promise<string> {
    const path = join(dir, 'fake-docker.sh');
    await writeFile(path, ['#!/bin/sh', ...lines].join('\n') + '\n');
    await chmod(path, 0o755);
    return path;
  }

  const source = {
    composeFile: '/opt/branchleft/acme/compose.yml',
    envFiles: ['/etc/a.env', '/etc/b.env'],
  };

  it('runs docker compose config --format json over the tenant files, in that order', async () => {
    expect(buildComposeConfigArgs(source)).toEqual([
      'compose',
      '-f',
      '/opt/branchleft/acme/compose.yml',
      '--env-file',
      '/etc/a.env',
      '--env-file',
      '/etc/b.env',
      'config',
      '--format',
      'json',
    ]);
    const argvLog = join(dir, 'argv.log');
    const fake = await fakeDocker([
      `for a in "$@"; do printf '%s\\n' "$a" >> '${argvLog}'; done`,
      `echo '{"name":"acme"}'`,
    ]);
    expect(await loadComposeConfig(source, fake)).toEqual({ name: 'acme' });
    expect((await readFile(argvLog, 'utf8')).trimEnd()).toBe(
      buildComposeConfigArgs(source).join('\n')
    );
  });

  it("gives Compose PATH only, so the operator's environment cannot fill a tenant ${VAR}", async () => {
    const probe = join(dir, 'env.log');
    const fake = await fakeDocker([
      `if [ -n "$EXPORT_BUNDLER_TEST_ENV_PROBE" ]; then echo present > '${probe}'; else echo absent > '${probe}'; fi`,
      `echo '{}'`,
    ]);
    process.env.EXPORT_BUNDLER_TEST_ENV_PROBE = 'must-not-leak';
    try {
      await loadComposeConfig(source, fake);
    } finally {
      delete process.env.EXPORT_BUNDLER_TEST_ENV_PROBE;
    }
    expect((await readFile(probe, 'utf8')).trim()).toBe('absent');
  });

  it('refuses when Compose fails, carrying its stderr', async () => {
    const fake = await fakeDocker([
      'echo "required variable GHOST_DB_PASSWORD is missing" >&2',
      'exit 15',
    ]);
    await expect(loadComposeConfig(source, fake)).rejects.toThrow(
      /exited 15: required variable GHOST_DB_PASSWORD is missing/
    );
  });

  it('refuses output that is not JSON', async () => {
    const fake = await fakeDocker(['echo "name: acme"']);
    await expect(loadComposeConfig(source, fake)).rejects.toThrow(TenantConfigError);
  });

  it('falls back to an empty PATH when this process has none', async () => {
    const saved = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(loadComposeConfig(source)).rejects.toThrow(TenantConfigError);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('mediaBaseUrlOf', () => {
  it("reads the tenant's media address from its own rendered environment", () => {
    expect(
      mediaBaseUrlOf({ storage__images__wrappedConfig__cdnUrl: 'https://m.test/opaque' })
    ).toBe('https://m.test/opaque');
    expect(mediaBaseUrlOf({ storage__images__cdnUrl: 'https://m.test/plain' })).toBe(
      'https://m.test/plain'
    );
  });

  it('is null for a tenant with no object-storage media', () => {
    expect(mediaBaseUrlOf({ storage__images__adapter: 'LocalImagesStorage' })).toBeNull();
  });
});
