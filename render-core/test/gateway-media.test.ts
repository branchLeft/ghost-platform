/**
 * A `gateway` tenant's media: one opaque folder in a shared shard, reached
 * through the storage gateway, served from the platform's own media address.
 * Pins the three values Ghost is given (the endpoint, `tenantPrefix`,
 * `cdnUrl`), that no artefact names a per-tenant bucket or a Hetzner key, and
 * that a folder equal to or containing the slug is refused.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FieldValidationError, type Slug } from '../src/brand.js';
import type { MediaSpec, TenantDescriptor } from '../src/descriptor.js';
import type { tenantEnvironment as TenantEnvironmentFn } from '../src/environment.js';
import { tenantEnvironment } from '../src/environment.js';
import type { validateMediaFolder as ValidateMediaFolderFn } from '../src/media.js';
import { MEDIA_BUCKET_PREFIX, validateMediaFolder } from '../src/media.js';
import { secretsEnvPath } from '../src/naming.js';
import { render, renderIdentity } from '../src/render.js';
import { uploadLimits } from '../src/runtime.js';
import {
  InvariantViolationError,
  TierMismatchError,
  UnknownDiscriminantError,
  validate,
  validateTenantStack,
} from '../src/validate.js';
import {
  GATEWAY_FOLDER,
  TEST_GATEWAY_ZONES,
  TEST_ZONES,
  demoDescriptor,
  gatewayTenantDescriptor,
} from './fixtures.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const here = dirname(fileURLToPath(import.meta.url));
const FEATURES = ['images', 'media', 'files'] as const;
const MEDIA_ORIGIN = 'https://media.platform-domain.example.test';
const GATEWAY = 'https://storage-gateway.internal.example.test';

type GatewayMedia = Extract<MediaSpec, { kind: 'gateway' }>;

function withMedia(changes: Partial<GatewayMedia>): TenantDescriptor {
  const descriptor = gatewayTenantDescriptor();
  return { ...descriptor, media: { ...(descriptor.media as GatewayMedia), ...changes } };
}

function envOf(
  fn: typeof TenantEnvironmentFn,
  descriptor: TenantDescriptor = gatewayTenantDescriptor()
): Record<string, string | number | boolean> {
  return fn(descriptor, uploadLimits(), secretsEnvPath(descriptor.slug), TEST_GATEWAY_ZONES);
}

describe('gateway media — what Ghost is given', () => {
  const env = envOf(tenantEnvironment, validate(gatewayTenantDescriptor(), TEST_GATEWAY_ZONES));

  it.each(FEATURES)('%s: endpoint, path style, tenantPrefix and cdnUrl', (feature) => {
    const key = (name: string): string => `storage__${feature}__wrappedConfig__${name}`;
    expect(env[`storage__${feature}__adapter`]).toBe('ScanningStorageAdapter');
    expect(env[`storage__${feature}__wraps`]).toBe('S3Storage');
    expect(env[key('endpoint')]).toBe(GATEWAY);
    expect(env[key('forcePathStyle')]).toBe(true);
    expect(env[key('tenantPrefix')]).toBe(GATEWAY_FOLDER);
    expect(env[key('cdnUrl')]).toBe(MEDIA_ORIGIN);
    expect(env[key('bucket')]).toBe('shard-a-example');
    expect(env[key('accessKeyId')]).toBe(
      '${GHOST_STORAGE_GATEWAY_KEY_ID:?set GHOST_STORAGE_GATEWAY_KEY_ID in /etc/branchleft/gw-co.env}'
    );
    expect(env[key('secretAccessKey')]).toBe(
      '${GHOST_STORAGE_GATEWAY_SECRET:?set GHOST_STORAGE_GATEWAY_SECRET in /etc/branchleft/gw-co.env}'
    );
  });

  it('the tenantPrefix never contains the slug', () => {
    for (const feature of FEATURES) {
      const prefix = String(env[`storage__${feature}__wrappedConfig__tenantPrefix`]);
      expect(prefix.toLowerCase()).not.toContain('gw-co');
    }
  });

  it('cdnUrl names neither the shard, nor the gateway, nor a per-tenant bucket', () => {
    const cdnUrl = String(env.storage__images__wrappedConfig__cdnUrl);
    expect(cdnUrl).not.toContain('shard-a-example');
    expect(cdnUrl).not.toContain('storage-gateway');
    expect(cdnUrl).not.toContain(MEDIA_BUCKET_PREFIX);
  });
});

describe('gateway media — the seven artefacts', () => {
  const artefacts = render(
    validate(gatewayTenantDescriptor(), TEST_GATEWAY_ZONES),
    TEST_GATEWAY_ZONES
  );

  it.each(artefacts.map((a) => [a.path, a.content] as const))(
    'is pinned by a golden test — %s',
    (path, content) => {
      expect(content).toBe(readFileSync(join(here, 'golden', `gateway-tenant.${path}`), 'utf-8'));
    }
  );

  it('no artefact names a per-tenant bucket or a Hetzner (S3) key', () => {
    for (const artefact of artefacts) {
      expect(artefact.content).not.toContain(MEDIA_BUCKET_PREFIX);
      expect(artefact.content).not.toContain('GHOST_S3_');
    }
  });

  it('the identity records the shard and the folder', () => {
    const identity = renderIdentity(validate(gatewayTenantDescriptor(), TEST_GATEWAY_ZONES));
    expect(identity.mediaBucket).toBe('shard-a-example');
    expect(identity.mediaFolder).toBe(GATEWAY_FOLDER);
  });

  it('validateTenantStack accepts the descriptor without ownerEmail', () => {
    const { ownerEmail: _ownerEmail, ...stack } = gatewayTenantDescriptor();
    expect(() =>
      validateTenantStack(stack, TEST_GATEWAY_ZONES, { claimantRepo: undefined })
    ).not.toThrow();
  });
});

describe('gateway media — refusals', () => {
  it.each([
    ['equal to the slug', 'gw-co'],
    ['equal to the slug, padded to the folder length', 'gw-co-0000000000000'],
    ['containing the slug', 'AbCdEfGh-gw-co-IjKlMnOp'],
    ['containing the slug in another case', 'AbCdEfGhGW-COIjKlMnOp'],
  ])('refuses a folder %s', (_label, folder) => {
    expect(() => validate(withMedia({ folder }), TEST_GATEWAY_ZONES)).toThrow(FieldValidationError);
    expect(() => validate(withMedia({ folder }), TEST_GATEWAY_ZONES)).toThrow(/media\.folder/);
  });

  it.each([
    ['too short', 'abc123'],
    ['with a slash', 'q7Zr2mXv9KpL/4tWb8NcE'],
    ['with a dot', 'q7Zr2mXv9KpL.4tWb8NcE'],
    ['empty', ''],
  ])('refuses a folder that is %s', (_label, folder) => {
    expect(() => validate(withMedia({ folder }), TEST_GATEWAY_ZONES)).toThrow(/media\.folder/);
  });

  it('refuses a descriptor with no folder: it never defaults to the slug', () => {
    const descriptor = gatewayTenantDescriptor();
    const { folder: _folder, ...media } = descriptor.media as GatewayMedia;
    expect(() =>
      validate({ ...descriptor, media } as unknown as TenantDescriptor, TEST_GATEWAY_ZONES)
    ).toThrow(/media\.folder/);
  });

  it('render() refuses a slug folder even on a descriptor that skipped validate()', () => {
    const descriptor = withMedia({ folder: 'gw-co-0000000000000' });
    expect(() => render(descriptor, TEST_GATEWAY_ZONES)).toThrow(/media\.folder/);
    expect(() => envOf(tenantEnvironment, descriptor)).toThrow(/media\.folder/);
  });

  it.each([
    ['a per-tenant bucket', `${MEDIA_BUCKET_PREFIX}gw-co`],
    ['a name containing the slug', 'shard-gw-co'],
    ['a malformed name', 'Shard_A'],
  ])('refuses a shard that is %s', (_label, shard) => {
    expect(() => validate(withMedia({ shard }), TEST_GATEWAY_ZONES)).toThrow(/media\.shard/);
  });

  it.each([
    ['http', 'http://storage-gateway.internal.example.test'],
    ['with a path', 'https://storage-gateway.internal.example.test/bucket'],
    ['with credentials', 'https://user:pass@storage-gateway.internal.example.test'],
    ['not a URL', 'storage-gateway'],
  ])('refuses a gateway endpoint that is %s', (_label, endpoint) => {
    expect(() => validate(withMedia({ endpoint }), TEST_GATEWAY_ZONES)).toThrow(/media\.endpoint/);
  });

  it('refuses a gateway descriptor when zones name no media address', () => {
    expect(() => validate(gatewayTenantDescriptor(), TEST_ZONES)).toThrow(/zones\.mediaOrigin/);
    expect(() => render(gatewayTenantDescriptor(), TEST_ZONES)).toThrow(/zones\.mediaOrigin/);
  });

  it.each([
    ['outside the owned domains', 'https://media.objects.example.test'],
    ['http', 'http://media.platform-domain.example.test'],
    ['with a path', 'https://media.platform-domain.example.test/bucket'],
    ['with a port', 'https://media.platform-domain.example.test:8443'],
  ])('refuses a media address %s', (_label, mediaOrigin) => {
    expect(() =>
      validate(gatewayTenantDescriptor(), { ...TEST_GATEWAY_ZONES, mediaOrigin })
    ).toThrow(/zones\.mediaOrigin/);
  });

  it('refuses gateway media on a demo', () => {
    const demo = demoDescriptor();
    const gateway = gatewayTenantDescriptor().media;
    // INV-3 answers first (a demo has no backup); with a backup, the tier rule does.
    expect(() => validate({ ...demo, media: gateway }, TEST_GATEWAY_ZONES)).toThrow(
      InvariantViolationError
    );
    const backedUp = {
      ...demo,
      media: gateway,
      backup: { kind: 'bucket-native', encryptionRecipient: 'age1qdemoexamplerecipient' },
    } as const;
    expect(() => validate(backedUp, TEST_GATEWAY_ZONES)).toThrow(TierMismatchError);
  });

  it('refuses gateway media without bucket-native backup (INV-3)', () => {
    expect(() =>
      validate({ ...gatewayTenantDescriptor(), backup: { kind: 'none' } }, TEST_GATEWAY_ZONES)
    ).toThrow(InvariantViolationError);
  });

  it('refuses an unknown key and an unknown media kind', () => {
    const descriptor = gatewayTenantDescriptor();
    const extra = { ...descriptor, media: { ...descriptor.media, bucket: 'x' } };
    expect(() => validate(extra as TenantDescriptor, TEST_GATEWAY_ZONES)).toThrow(/unknown key/);
    const unknown = { ...descriptor, media: { ...descriptor.media, kind: 'r2' } };
    expect(() => validate(unknown as unknown as TenantDescriptor, TEST_GATEWAY_ZONES)).toThrow(
      UnknownDiscriminantError
    );
  });
});

describe('gateway media — source-mutation sabotage', () => {
  it('a folder check that lets the slug through is caught; the real one refuses it', async () => {
    // RED: the folder may now be the slug.
    const sabotaged = await importSabotaged<{ validateMediaFolder: typeof ValidateMediaFolderFn }>(
      'media.ts',
      (source) => {
        const target = 'if (folder.toLowerCase().includes(slug.toLowerCase())) {';
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in media.ts -- update the mutation');
        }
        return source.replace(target, 'if (false) {');
      }
    );
    const media = (withMedia({ folder: 'gw-co-0000000000000' }) as { media: MediaSpec }).media;
    expect(() => sabotaged.validateMediaFolder('gw-co' as Slug, media)).not.toThrow();

    // GREEN: the real module refuses it.
    expect(() => validateMediaFolder('gw-co' as Slug, media)).toThrow(/media\.folder/);
  });

  it('a tenantPrefix that defaults to the slug is caught; the real one renders the folder', async () => {
    // RED: render the slug where the folder belongs.
    const sabotaged = await importSabotaged<{ tenantEnvironment: typeof TenantEnvironmentFn }>(
      'environment.ts',
      (source) => {
        const target = 'env[`${prefix}tenantPrefix`] = media.folder;';
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in environment.ts -- update the mutation');
        }
        return source.replace(target, 'env[`${prefix}tenantPrefix`] = slug;');
      }
    );
    expect(envOf(sabotaged.tenantEnvironment).storage__images__wrappedConfig__tenantPrefix).toBe(
      'gw-co'
    );

    // GREEN: the real module renders the folder.
    expect(envOf(tenantEnvironment).storage__images__wrappedConfig__tenantPrefix).toBe(
      GATEWAY_FOLDER
    );
  });
});
