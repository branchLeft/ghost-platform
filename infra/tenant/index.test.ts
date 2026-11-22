import {
  OWN_ORIGIN_WIDGETS,
  render,
  validateTenantStack,
  type TenantStackDescriptor,
} from '@branchleft/ghost-platform-render-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { requiredSecretKeys, type GhostTenant as GhostTenantClass } from './index';
import { TEST_ZONES, demoDescriptor, tenantZeroEquivalent } from './test/fixtures';
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
  descriptor: TenantStackDescriptor = tenantZeroEquivalent()
): GhostTenantClass {
  return new GhostTenant(name, { descriptor, zones: TEST_ZONES });
}

function rendered(descriptor: TenantStackDescriptor = tenantZeroEquivalent()): Map<string, string> {
  return new Map(
    render(validateTenantStack(descriptor, TEST_ZONES), TEST_ZONES, undefined, {
      activeColour: 'a',
    }).map((a) => [a.path, a.content])
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

describe('GhostTenant widgets', () => {
  const OWN_ORIGIN_KEYS = Object.keys(OWN_ORIGIN_WIDGETS);

  function composeWith(args: Record<string, unknown>): string {
    return new GhostTenant('widgets', {
      descriptor: tenantZeroEquivalent(),
      zones: TEST_ZONES,
      ...args,
    }).composeFile;
  }

  it('leaves the compose file byte-identical to colour a when no widget option is given', () => {
    expect(composeWith({})).toBe(rendered().get('compose.yml'));
    expect(composeWith({})).not.toContain('/bl-assets/');
  });

  it('renders every widget address from the tenant origin with own-origin', () => {
    const compose = composeWith({ widgets: 'own-origin' });
    expect(OWN_ORIGIN_KEYS).toHaveLength(7);
    for (const [key, file] of Object.entries(OWN_ORIGIN_WIDGETS)) {
      expect(compose).toContain(`${key}: 'https://`);
      expect(compose).toContain(`/bl-assets/${file}`);
    }
    expect(compose).not.toContain('jsdelivr');
  });

  it('matches what render() returns for the same options', () => {
    const expected = new Map(
      render(validateTenantStack(tenantZeroEquivalent(), TEST_ZONES), TEST_ZONES, undefined, {
        activeColour: 'a',
        widgets: 'own-origin',
      }).map((a) => [a.path, a.content])
    );
    expect(composeWith({ widgets: 'own-origin' })).toBe(expected.get('compose.yml'));
  });

  it('switches FirstPromoter and Transistor off by default, and back on when told', () => {
    const blocked = composeWith({ widgets: 'own-origin' });
    expect(blocked).toContain('hostSettings__settingsOverrides__firstpromoter: false');
    expect(blocked).toContain('hostSettings__settingsOverrides__transistor: false');
    const left = composeWith({ widgets: 'own-origin', blockThirdPartyIntegrations: false });
    expect(left).not.toContain('settingsOverrides__firstpromoter');
    expect(left).not.toContain('settingsOverrides__transistor');
  });

  it('ignores blockThirdPartyIntegrations without own-origin', () => {
    expect(composeWith({ blockThirdPartyIntegrations: false })).toBe(rendered().get('compose.yml'));
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

  it('outputs the render core secrets template as rendered, key names only', () => {
    const template = rendered().get('secrets.env') as string;
    const tenant = build('secrets');
    expect(tenant.secretsEnvTemplate).toBe(template);
    expect(tenant.secretKeys).toEqual(requiredSecretKeys(template));
    expect(tenant.secretKeys).toEqual([
      'GHOST_DB_PASSWORD',
      'GHOST_S3_ACCESS_KEY_ID',
      'GHOST_S3_SECRET_ACCESS_KEY',
      'GHOST_MAIL_PASSWORD',
      'GHOST_BULK_EMAIL_API_KEY',
      'GHOST_OWNER_EMAIL',
    ]);
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
    const { ownerEmail: _ownerEmail, ...demo } = demoDescriptor();
    refusesUnregistered('demo', () => build('demo', demo), /must be "tenant"/);
  });

  it('refuses a descriptor the render core does not validate', () => {
    const invalid = {
      ...tenantZeroEquivalent(),
      slug: 'Not A Slug',
    } as unknown as TenantStackDescriptor;
    refusesUnregistered('invalid', () => build('invalid', invalid), /slug/);
  });

  it('refuses a descriptor that still carries ownerEmail, without echoing it', () => {
    const inline = {
      ...tenantZeroEquivalent(),
      ownerEmail: 'inline-owner-3d8f@example.test',
    } as unknown as TenantStackDescriptor;
    expect(() => build('inline-owner', inline)).not.toThrow(/inline-owner-3d8f/);
    refusesUnregistered('inline-owner', () => build('inline-owner', inline), /must not carry/);
  });

  it('refuses a secrets argument, never dropping it and never echoing it', () => {
    const sentinel = 'PLACEHOLDER_REMOVED_ARGUMENT_9f3a';
    const act = () =>
      new GhostTenant('removed-argument', {
        descriptor: tenantZeroEquivalent(),
        zones: TEST_ZONES,
        secrets: { databasePassword: sentinel },
      } as unknown as ConstructorParameters<typeof GhostTenantClass>[1]);
    expect(act).toThrow(/"secrets" argument was removed/);
    expect(act).not.toThrow(new RegExp(sentinel));
    expect(created.some((r) => r.name === 'removed-argument')).toBe(false);
  });
});

describe('requiredSecretKeys', () => {
  it('reads only KEY= lines, in order', () => {
    expect(requiredSecretKeys('# A=\nB=\nC=x\nD=\n')).toEqual(['B', 'D']);
  });
});
