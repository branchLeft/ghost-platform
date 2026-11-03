import * as pulumi from '@pulumi/pulumi';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { TEST_ZONES, tenantZeroEquivalent } from './test/fixtures';
import { created, installMocks } from './test/harness';
import { findLeaks, gatherExposures } from './test/leaks';

/**
 * A tenant stack's state holds no secret value. The component takes no
 * secret, so the sentinels are placed where one could still arrive: the
 * removed `secrets` argument, and the stack config the old template read
 * them from. Everything the component exposes is then searched for them, and
 * checked for any Pulumi secret marker. See secrets-absent.md.
 */

const SENTINELS = {
  databasePassword: 'sentinel-db-password-4c1e7a90',
  mediaAccessKeyId: 'sentinel-s3-key-id-5d2f8b01',
  mediaSecretAccessKey: 'sentinel-s3-secret-6e309c12',
  mailPassword: 'sentinel-mail-password-7f41ad23',
  bulkEmailApiKey: 'sentinel-bulk-key-8a52be34',
  ownerEmail: 'sentinel-owner-9b63cf45@sentinel-owner.example.test',
};
const SENTINEL_VALUES = Object.values(SENTINELS);

/** Every output key the component may register. A new one is a review decision. */
const ALLOWED_OUTPUT_KEYS = [
  'identity',
  'composeFile',
  'composeUnit',
  'stackDirectory',
  'secretsEnvPath',
  'imageEnvPath',
  'imageEnvFile',
  'provisionScript',
  'edgeSiteBlock',
  'edgeRequestBodyMaxSize',
  'ghostSettings',
  'mediaBucket',
  'mediaPublicBaseUrl',
  'secretsEnvTemplate',
  'secretKeys',
];

let GhostTenant: typeof GhostTenantClass;

beforeAll(async () => {
  installMocks();
  ({ GhostTenant } = await import('./index.js'));
});

/** The six values the old template read with `requireSecret`, sitting in stack config. */
function putSecretsInStackConfig(): void {
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(SENTINELS)) {
    config[`ghost-tenant-test:${key}`] = value;
  }
  pulumi.runtime.setAllConfig(config, Object.keys(config));
}

afterEach(() => {
  pulumi.runtime.setAllConfig({}, []);
});

function build(name: string): GhostTenantClass {
  return new GhostTenant(name, { descriptor: tenantZeroEquivalent(), zones: TEST_ZONES });
}

describe('the tenant component exposes no secret value', () => {
  it('has none in any field, registered input or recorded output, and none marked secret', async () => {
    putSecretsInStackConfig();
    const exposed = await gatherExposures('absent', () => build('absent'));
    expect(exposed.exposures.length).toBeGreaterThan(15);
    expect(findLeaks(exposed, SENTINEL_VALUES, ALLOWED_OUTPUT_KEYS)).toEqual([]);
  });

  it('registers exactly the allowlisted output keys', async () => {
    const exposed = await gatherExposures('keys', () => build('keys'));
    expect([...exposed.recordedKeys].sort()).toEqual([...ALLOWED_OUTPUT_KEYS].sort());
  });

  it('refuses a secrets argument carrying the sentinels, and echoes none of them', () => {
    const act = () =>
      new GhostTenant('hidden-argument', {
        descriptor: tenantZeroEquivalent(),
        zones: TEST_ZONES,
        secrets: SENTINELS,
      } as unknown as ConstructorParameters<typeof GhostTenantClass>[1]);
    expect(act).toThrow(/"secrets" argument was removed/);
    try {
      act();
    } catch (error) {
      for (const sentinel of SENTINEL_VALUES) {
        expect((error as Error).message).not.toContain(sentinel);
      }
    }
    expect(created.some((r) => r.name === 'hidden-argument')).toBe(false);
  });

  it('outputs a secrets template that names keys and carries no value', () => {
    const tenant = build('template');
    const lines = tenant.secretsEnvTemplate.split('\n');
    const keyLines = lines.filter((line) => !line.startsWith('#') && line !== '');
    expect(keyLines.length).toBeGreaterThan(0);
    for (const line of keyLines) {
      expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
    }
    expect(keyLines.map((line) => line.slice(0, -1))).toEqual(tenant.secretKeys);
  });
});

/**
 * Control cases. An all-clear means nothing unless the same check can fail,
 * so each stand-in below leaks one way a component could, is gathered by the
 * same code, and must be reported.
 */
describe('control: the check fails when a secret reappears', () => {
  class LeakingStandIn extends pulumi.ComponentResource {
    public readonly secretsEnvFile: pulumi.Output<string>;
    public readonly plain: string;

    constructor(
      name: string,
      how: 'secret-field' | 'plain-field' | 'recorded-output' | 'extra-key'
    ) {
      super('ghostPlatform:tenant:LeakingStandIn', name, {}, undefined);
      const filled = `GHOST_DB_PASSWORD=${SENTINELS.databasePassword}\n`;
      this.secretsEnvFile = pulumi.secret(how === 'secret-field' ? filled : 'GHOST_DB_PASSWORD=\n');
      this.plain = how === 'plain-field' ? filled : 'GHOST_DB_PASSWORD=\n';
      this.registerOutputs(
        how === 'recorded-output'
          ? { secretsEnvTemplate: pulumi.secret(filled) }
          : how === 'extra-key'
            ? { secretsEnvTemplate: 'GHOST_DB_PASSWORD=\n', extra: 'x' }
            : { secretsEnvTemplate: 'GHOST_DB_PASSWORD=\n' }
      );
    }
  }

  it.each([
    ['a Pulumi secret field holding a value', 'secret-field', /secretsEnvFile is a Pulumi secret/],
    ['a plain field holding a value', 'plain-field', /field plain carries a sentinel/],
    [
      'a secret recorded by registerOutputs',
      'recorded-output',
      /registered output secretsEnvTemplate is a Pulumi secret/,
    ],
    ['an output key off the allowlist', 'extra-key', /extra is not on the allowlist/],
  ] as const)('reports %s', async (_label, how, expected) => {
    const name = `leak-${how}`;
    const exposed = await gatherExposures(name, () => new LeakingStandIn(name, how));
    const problems = findLeaks(exposed, SENTINEL_VALUES, ['secretsEnvTemplate']);
    expect(problems.join('\n')).toMatch(expected);
  });

  it('reports nothing for a stand-in that leaks nothing', async () => {
    const name = 'leak-none';
    // A secret-marked field with no sentinel is still a secret, so the clean
    // control has to avoid the marker entirely.
    class Clean extends pulumi.ComponentResource {
      constructor() {
        super('ghostPlatform:tenant:Clean', name, {}, undefined);
        this.registerOutputs({ secretsEnvTemplate: 'GHOST_DB_PASSWORD=\n' });
      }
    }
    const exposed = await gatherExposures(name, () => new Clean());
    expect(findLeaks(exposed, SENTINEL_VALUES, ['secretsEnvTemplate'])).toEqual([]);
  });
});
