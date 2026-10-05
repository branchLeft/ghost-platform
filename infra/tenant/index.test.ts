import * as pulumi from '@pulumi/pulumi';
import { render, validate, type TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertSecretCoverage,
  fillSecretsTemplate,
  requiredSecretKeys,
  type GhostTenant as GhostTenantClass,
  type GhostTenantSecrets,
} from './index';
import {
  TEST_ZONES,
  demoDescriptor,
  tenantZeroEquivalent,
  tenantZeroSecrets,
} from './test/fixtures';
import { created, installMocks, settle, unwrap } from './test/harness';

/**
 * Runs `GhostTenant` under Pulumi's mocks and inspects what it registers and
 * outputs. The component must render nothing itself: every artefact output
 * is compared byte-for-byte with what the render core returns for the same
 * descriptor.
 */

let GhostTenant: typeof GhostTenantClass;

beforeAll(async () => {
  installMocks();
  ({ GhostTenant } = await import('./index.js'));
});

function build(
  name: string,
  descriptor: TenantDescriptor = tenantZeroEquivalent(),
  secrets: GhostTenantSecrets = tenantZeroSecrets()
): GhostTenantClass {
  return new GhostTenant(name, { descriptor, zones: TEST_ZONES, secrets });
}

function rendered(descriptor: TenantDescriptor = tenantZeroEquivalent()): Map<string, string> {
  return new Map(
    render(validate(descriptor, TEST_ZONES), TEST_ZONES).map((a) => [a.path, a.content])
  );
}

function registered(name: string) {
  const found = created.find(
    (r) => r.type === 'ghostPlatform:tenant:GhostTenant' && r.name === name
  );
  if (found === undefined) {
    throw new Error(`no ghostPlatform:tenant:GhostTenant named ${name} was registered`);
  }
  return found;
}

describe('GhostTenant identity', () => {
  it('registers its identity fields as real component props, not empty inputs', async () => {
    build('identity');
    await settle();
    // `super(token, name, {}, opts)` would leave `inputs` empty here.
    expect(registered('identity').inputs.identity).toEqual({
      slug: 'zero',
      uid: 30001,
      stackName: 'zero',
      contentVolume: 'ghost-zero-content',
      adaptersVolume: 'ghost-zero-adapters',
      databaseName: 'ghost_zero',
      appHostPrivateIp: '10.20.1.100',
      maxUserConnections: 10,
    });
  });

  it('carries an explicit maxUserConnections into the identity', async () => {
    const tenant = new GhostTenant('cap', {
      descriptor: tenantZeroEquivalent(),
      zones: TEST_ZONES,
      secrets: tenantZeroSecrets(),
      maxUserConnections: 25,
    });
    expect((await unwrap(tenant.identity)).maxUserConnections).toBe(25);
  });

  it('takes every identity field from the render core, not a second derivation', async () => {
    const identity = JSON.parse(rendered().get('identity.json') as string) as Record<
      string,
      unknown
    >;
    const tenant = build('identity-source');
    const ours = (await unwrap(tenant.identity)) as unknown as Record<string, unknown>;
    for (const field of [
      'slug',
      'uid',
      'stackName',
      'contentVolume',
      'adaptersVolume',
      'databaseName',
      'appHostPrivateIp',
    ]) {
      expect(ours[field]).toEqual(identity[field]);
    }
  });
});

describe('GhostTenant renders nothing itself', () => {
  it('outputs each non-secret artefact exactly as render() returns it', () => {
    const tenant = build('artefacts');
    const expected = rendered();
    expect(tenant.composeFile).toBe(expected.get('compose.yml'));
    expect(tenant.imageEnvFile).toBe(expected.get('image.env'));
    expect(tenant.provisionScript).toBe(expected.get('provision.sh'));
    expect(tenant.edgeSiteBlock).toBe(expected.get('edge.json'));
    expect(tenant.ghostSettings).toBe(expected.get('ghost-settings.json'));
  });

  it('reads the edge request-body limit out of the rendered edge block', () => {
    const tenant = build('edge');
    const edge = JSON.parse(rendered().get('edge.json') as string) as {
      requestBodyMaxSize: string;
    };
    expect(tenant.edgeRequestBodyMaxSize).toBe(edge.requestBodyMaxSize);
    expect(tenant.edgeRequestBodyMaxSize).toBe('64MiB');
  });

  it('changes only the KEY= lines of the render core secrets template', async () => {
    const template = rendered().get('secrets.env') as string;
    const filled = await unwrap(build('secrets').secretsEnvFile);
    const templateLines = template.split('\n');
    const filledLines = filled.split('\n');
    expect(filledLines).toHaveLength(templateLines.length);
    templateLines.forEach((line, index) => {
      if (/^[A-Z][A-Z0-9_]*=$/.test(line)) {
        expect(filledLines[index].startsWith(line)).toBe(true);
        expect(filledLines[index].length).toBeGreaterThan(line.length);
      } else {
        expect(filledLines[index]).toBe(line);
      }
    });
    expect(filled).toContain('GHOST_DB_PASSWORD=PLACEHOLDER_DB_PASSWORD\n');
    expect(filled).toContain('GHOST_BULK_EMAIL_API_KEY=PLACEHOLDER_BULK_KEY\n');
  });

  it('marks the secrets file as a Pulumi secret', async () => {
    const tenant = build('secret-flag');
    expect(await pulumi.isSecret(tenant.secretsEnvFile)).toBe(true);
  });

  it('derives the scalar outputs from the render core naming', () => {
    const tenant = build('scalars');
    expect({
      stackName: tenant.stackName,
      stackDirectory: tenant.stackDirectory,
      composeUnit: tenant.composeUnit,
      secretsEnvPath: tenant.secretsEnvPath,
      imageEnvPath: tenant.imageEnvPath,
      databaseUser: tenant.databaseUser,
      mediaBucket: tenant.mediaBucket,
      mediaPublicBaseUrl: tenant.mediaPublicBaseUrl,
    }).toEqual({
      stackName: 'zero',
      stackDirectory: '/opt/branchleft/zero',
      composeUnit: 'branchleft-compose@zero.service',
      secretsEnvPath: '/etc/branchleft/zero.env',
      imageEnvPath: '/etc/branchleft/zero.image.env',
      databaseUser: 'ghost_zero',
      mediaBucket: 'branchleft-media-zero',
      mediaPublicBaseUrl: 'https://objects.example.test/branchleft-media-zero',
    });
  });
});

describe('GhostTenant refusals, all before anything is registered', () => {
  function refusesUnregistered(name: string, act: () => unknown, message: RegExp): void {
    expect(act).toThrow(message);
    expect(created.some((r) => r.name === name)).toBe(false);
  }

  it('refuses a demo descriptor', () => {
    refusesUnregistered('demo', () => build('demo', demoDescriptor(), {}), /must be "tenant"/);
  });

  it('refuses a descriptor the render core does not validate', () => {
    const invalid = {
      ...tenantZeroEquivalent(),
      slug: 'Not A Slug',
    } as unknown as TenantDescriptor;
    refusesUnregistered('invalid', () => build('invalid', invalid), /slug/);
  });

  it('refuses a missing required secret', () => {
    const { bulkEmailApiKey: _omitted, ...rest } = tenantZeroSecrets();
    refusesUnregistered(
      'missing',
      () => build('missing', tenantZeroEquivalent(), rest),
      /bulkEmailApiKey/
    );
  });

  it('refuses a secret the descriptor does not need', () => {
    const queue = {
      ...tenantZeroEquivalent(),
      transport: { kind: 'queue', path: '/var/spool/zero' },
    } as unknown as TenantDescriptor;
    refusesUnregistered('orphan', () => build('orphan', queue), /mailPassword was supplied/);
  });
});

describe('fillSecretsTemplate', () => {
  const template = '# header\nGHOST_DB_PASSWORD=\nGHOST_MAIL_PASSWORD=\n';

  it('refuses a value carrying a newline, which would add a variable', () => {
    const values = new Map([
      ['GHOST_DB_PASSWORD', 'ok'],
      ['GHOST_MAIL_PASSWORD', 'pw\nGHOST_DB_PASSWORD=attacker'],
    ]);
    expect(() => fillSecretsTemplate('zero', template, values)).toThrow(/control character/);
  });

  it('refuses a key the template names but no value fills', () => {
    expect(() =>
      fillSecretsTemplate('zero', template, new Map([['GHOST_DB_PASSWORD', 'ok']]))
    ).toThrow(/no value for GHOST_MAIL_PASSWORD/);
  });

  it('leaves comment lines and the trailing newline untouched', () => {
    const values = new Map([
      ['GHOST_DB_PASSWORD', 'a'],
      ['GHOST_MAIL_PASSWORD', 'b'],
    ]);
    expect(fillSecretsTemplate('zero', template, values)).toBe(
      '# header\nGHOST_DB_PASSWORD=a\nGHOST_MAIL_PASSWORD=b\n'
    );
  });
});

describe('requiredSecretKeys and assertSecretCoverage', () => {
  it('reads only KEY= lines, in order', () => {
    expect(requiredSecretKeys('# A=\nB=\nC=x\nD=\n')).toEqual(['B', 'D']);
  });

  it('refuses a template key this component has no input for', () => {
    expect(() => assertSecretCoverage('zero', ['GHOST_UNKNOWN'], {})).toThrow(/no input for/);
  });
});
