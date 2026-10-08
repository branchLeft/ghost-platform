import {
  UnattributedPromotionDiffError,
  assertAttributablePromotionDiff,
  render,
  transform,
  validate,
  type PromotionTargets,
  type TenantDescriptor,
} from '@branchleft/ghost-platform-render-core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { TEST_ZONES, demoDescriptor } from './test/fixtures';
import { installMocks, unwrap } from './test/harness';

/**
 * The render core's falsifying test, run against this component: promote a
 * demo with `transform()`, placement held fixed, hand the result to
 * `GhostTenant`, and check that every difference from the demo's own render
 * is attributable. See falsifying.md.
 */

const TARGETS: PromotionTargets = {
  databaseHost: '10.20.1.20',
  databasePort: 3306,
  mediaEndpoint: 'https://objects.example.test',
  mediaRegion: 'region-1',
  mediaResize: true,
  mediaSrcsets: true,
  backupEncryptionRecipient: 'age1qplaceholderpromotionrecipient',
  limits: { membersCap: null, staffCap: null },
  mailIdentity: { domain: 'promoted-mail.example.test', dkimSelector: 'bl' },
  mailEnabled: true,
  mailCeiling: 10000,
  mailEstateCeiling: 10000,
} as unknown as PromotionTargets;

const SECRETS = {
  databasePassword: 'PLACEHOLDER_DB_PASSWORD',
  s3AccessKeyId: 'PLACEHOLDER_S3_KEY_ID',
  s3SecretAccessKey: 'PLACEHOLDER_S3_SECRET',
  bulkEmailApiKey: 'PLACEHOLDER_BULK_KEY',
};

let GhostTenant: typeof GhostTenantClass;

beforeAll(async () => {
  installMocks();
  ({ GhostTenant } = await import('./index.js'));
});

function artefacts(descriptor: TenantDescriptor): Map<string, string> {
  return new Map(
    render(validate(descriptor, TEST_ZONES), TEST_ZONES).map((a) => [a.path, a.content])
  );
}

describe('the falsifying test against the rewired component', () => {
  const demo = validate(demoDescriptor(), TEST_ZONES);
  const promoted = transform(demo, TEST_ZONES, TARGETS);
  // A promotion moves the demo's inline owner address to the secret path.
  const { ownerEmail, ...promotedStack } = promoted;
  const secrets = { ...SECRETS, ownerEmail };

  it('transform() moves only the attributable fields', () => {
    expect(() => assertAttributablePromotionDiff(demo, promoted)).not.toThrow();
  });

  it('the component accepts the promoted descriptor and outputs exactly its render', () => {
    const tenant = new GhostTenant('promoted', {
      descriptor: promotedStack,
      zones: TEST_ZONES,
      secrets,
    });
    const expected = artefacts(promoted);
    expect(tenant.composeFile).toBe(expected.get('compose.yml'));
    expect(tenant.edgeSiteBlock).toBe(expected.get('edge.json'));
    expect(tenant.ghostSettings).toBe(expected.get('ghost-settings.json'));
    expect(tenant.provisionScript).toBe(expected.get('provision.sh'));
  });

  it('keeps every slug- and placement-derived value of the demo', async () => {
    const tenant = new GhostTenant('placement', {
      descriptor: promotedStack,
      zones: TEST_ZONES,
      secrets,
    });
    const demoIdentity = JSON.parse(artefacts(demo).get('identity.json') as string) as Record<
      string,
      unknown
    >;
    const identity = (await unwrap(tenant.identity)) as unknown as Record<string, unknown>;
    for (const field of [
      'slug',
      'uid',
      'stackName',
      'contentVolume',
      'adaptersVolume',
      'appHostPrivateIp',
    ]) {
      expect(identity[field]).toEqual(demoIdentity[field]);
    }
    expect(tenant.imageEnvFile).toBe(artefacts(demo).get('image.env'));
  });

  it('control case: one extra hand-edited field is rejected, naming that field', () => {
    const tampered = { ...promoted, appHostIp: '10.20.1.51' } as unknown as TenantDescriptor;
    expect(() => assertAttributablePromotionDiff(demo, tampered)).toThrow(
      UnattributedPromotionDiffError
    );
    expect(() => assertAttributablePromotionDiff(demo, tampered)).toThrow(/appHostIp/);
  });
});
