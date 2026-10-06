/**
 * The real tenant-zero parity proof: a real key-by-key diff against
 * `infra/tenant`'s own renderer. `INFRA_TENANT_BLOG_ENV` is recorded real
 * output, not fabricated. See parity.md#the-parity-proof.
 */
import { describe, expect, it } from 'vitest';
import type {
  AbsoluteUrl,
  DigestPinnedRef,
  EmailAddress,
  Instant,
  Port,
  PrivateIpV4,
  Slug,
  TenantUid,
} from '../src/brand.js';
import { CURRENT_SCHEMA_VERSION, type ZoneConfig } from '../src/validate.js';
import type { TenantDescriptor } from '../src/descriptor.js';
import { tenantEnvironment as renderCoreTenantEnvironment } from '../src/environment.js';
import { uploadLimits } from '../src/runtime.js';
import { MAIL_SPOOL_BASE_URL } from '../src/spool.js';

const SECRETS_FILE_PATH = '/etc/branchleft/blog.env';

// Not `TEST_ZONES` from `./fixtures.js`: this fixture is tenant-zero's own
// real domain, and `demoMailDomain` is never read for a `tenant` identity —
// the bulk base URL comes from `spool.ts`, and is deliberately not
// `INFRA_TENANT_BLOG_ENV`'s old `mx1.branchleft.co.uk:8443` — see
// `KNOWN_DIVERGED_KEYS`'s own comment below for why.
const ZONES: Pick<ZoneConfig, 'demoMailDomain'> = {
  demoMailDomain: 'demo.branchleft.co.uk',
};

// Recorded 2026-09-24 by calling infra/tenant/environment.ts#tenantEnvironment
// directly, in this same worktree, with the values below — see the module
// doc comment. Do not hand-edit; regenerate the same way if infra/tenant's
// renderer changes.
const INFRA_TENANT_BLOG_ENV: Readonly<Record<string, string | number | boolean>> = {
  url: 'https://blog.branchleft.co.uk',
  database__client: 'mysql',
  database__connection__host: '10.20.1.20',
  database__connection__port: 3306,
  database__connection__database: 'ghost_blog',
  database__connection__user: 'ghost_blog',
  database__connection__password: `\${GHOST_DB_PASSWORD:?set GHOST_DB_PASSWORD in ${SECRETS_FILE_PATH}}`,
  database__connection__ssl__rejectUnauthorized: false,
  storage__active: 'S3Storage',
  storage__S3Storage__bucket: 'branchleft-media-blog',
  storage__S3Storage__region: 'hel1',
  storage__S3Storage__endpoint: 'https://hel1.your-objectstorage.com',
  storage__S3Storage__forcePathStyle: true,
  storage__S3Storage__staticFileURLPrefix: 'content/images',
  storage__S3Storage__cdnUrl: 'https://hel1.your-objectstorage.com/branchleft-media-blog',
  storage__S3Storage__multipartUploadThresholdBytes: 10485760,
  storage__S3Storage__multipartChunkSizeBytes: 5242880,
  storage__S3Storage__accessKeyId: `\${GHOST_S3_ACCESS_KEY_ID:?set GHOST_S3_ACCESS_KEY_ID in ${SECRETS_FILE_PATH}}`,
  storage__S3Storage__secretAccessKey: `\${GHOST_S3_SECRET_ACCESS_KEY:?set GHOST_S3_SECRET_ACCESS_KEY in ${SECRETS_FILE_PATH}}`,
  security__allowWebhookInternalIPs: false,
  theme__uploadLimits__compressedBytes: 33554432,
  theme__uploadLimits__entryUncompressedBytes: 33554432,
  theme__uploadLimits__totalUncompressedBytes: 67108864,
  privacy__useUpdateCheck: false,
  logging__transports: '["stdout"]',
  mail__transport: 'SMTP',
  mail__options__host: 'mx1.branchleft.co.uk',
  mail__options__port: 587,
  mail__options__secure: false,
  mail__options__auth__user: 'blog@branchleft.co.uk',
  mail__options__auth__pass: `\${GHOST_MAIL_PASSWORD:?set GHOST_MAIL_PASSWORD in ${SECRETS_FILE_PATH}}`,
  mail__from: 'branchLeft blog <blog@branchleft.co.uk>',
  bulkEmail__mailgun__baseUrl: 'https://mx1.branchleft.co.uk:8443',
  bulkEmail__mailgun__domain: 'blog.branchleft.co.uk',
  bulkEmail__mailgun__apiKey: `\${GHOST_BULK_EMAIL_API_KEY:?set GHOST_BULK_EMAIL_API_KEY in ${SECRETS_FILE_PATH}}`,
};

function renderCoreTenantZeroDescriptor(): TenantDescriptor {
  const DIGEST = '4'.repeat(64);
  return {
    version: CURRENT_SCHEMA_VERSION,
    kind: 'tenant',
    slug: 'blog' as Slug,
    siteUrl: 'https://blog.branchleft.co.uk' as AbsoluteUrl,
    image: `ghost:6.55.0-alpine@sha256:${DIGEST}` as DigestPinnedRef,
    ownerEmail: 'owner@branchleft.co.uk' as EmailAddress,
    uid: 30001 as TenantUid,
    ports: { a: 8101 as Port, b: 8102 as Port, health: 8103 as Port },
    appHostIp: '10.20.1.100' as PrivateIpV4,
    database: {
      kind: 'mysql',
      host: '10.20.1.20',
      port: 3306 as Port,
      name: 'ghost_blog',
      user: 'ghost_blog',
    },
    media: {
      kind: 's3',
      endpoint: 'https://hel1.your-objectstorage.com',
      region: 'hel1',
      bucket: 'branchleft-media-blog',
      resize: true,
      srcsets: true,
    },
    transport: {
      kind: 'smtp',
      host: 'mx1.branchleft.co.uk',
      port: 587 as Port,
      user: 'blog@branchleft.co.uk',
    },
    mail: {
      enabled: true,
      ceiling: 100000,
      estateCeiling: 100000,
      identity: { kind: 'tenant', domain: 'blog.branchleft.co.uk', dkimSelector: 'bl' },
    },
    hostname: {
      kind: 'theirs',
      fqdn: 'blog.branchleft.co.uk',
      verifiedAt: '2026-01-01T00:00:00.000Z' as Instant,
    },
    gate: { kind: 'none' },
    backup: { kind: 'bucket-native', encryptionRecipient: 'age1qblogrecipient' },
    codeInjection: { kind: 'blocked' },
    limits: { membersCap: null, staffCap: null },
    caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
    safety: { near: true, exact: true },
    breakGlass: { kind: 'disabled' },
    expiresAt: null,
  };
}

function renderCoreTenantZeroEnv(): Record<string, string | number | boolean> {
  return renderCoreTenantEnvironment(
    renderCoreTenantZeroDescriptor(),
    uploadLimits(),
    SECRETS_FILE_PATH,
    ZONES
  );
}

/**
 * The eleven `storage__*` keys are the one remaining gap, because tenant-zero
 * has not been migrated onto the scanning decorator. See
 * parity.md#known-gap-keys.
 */
const KNOWN_GAP_KEYS = [
  'storage__active',
  'storage__S3Storage__bucket',
  'storage__S3Storage__region',
  'storage__S3Storage__endpoint',
  'storage__S3Storage__forcePathStyle',
  'storage__S3Storage__staticFileURLPrefix',
  'storage__S3Storage__cdnUrl',
  'storage__S3Storage__multipartUploadThresholdBytes',
  'storage__S3Storage__multipartChunkSizeBytes',
  'storage__S3Storage__accessKeyId',
  'storage__S3Storage__secretAccessKey',
].sort();

/**
 * Two sending-identity keys are a deliberate, permanent divergence, not a
 * defect: render-core points at the host's own mail spool, the old
 * snapshot still points at mx1. See parity.md#known-diverged-keys.
 */
const KNOWN_DIVERGED_KEYS = ['mail__from', 'bulkEmail__mailgun__baseUrl'].sort();

/**
 * The keys render-core renders for the scanning decorator that
 * `infra/tenant/environment.ts` has no equivalent for at all — the
 * mirror image of `KNOWN_GAP_KEYS`. Generated from the same three-feature,
 * fixed-suffix shape `environment.ts#mediaEnvironment` renders, rather than
 * hand-typed, because 39 near-identical hand-typed keys is exactly where a
 * copy-paste slip would silently pass.
 */
const DECORATOR_WRAPPED_CONFIG_SUFFIXES = [
  'bucket',
  'region',
  'endpoint',
  'forcePathStyle',
  'staticFileURLPrefix',
  'cdnUrl',
  'multipartUploadThresholdBytes',
  'multipartChunkSizeBytes',
  'accessKeyId',
  'secretAccessKey',
];
const EXTRA_IN_CORE_KEYS = (['images', 'media', 'files'] as const)
  .flatMap((feature) => [
    `storage__${feature}__adapter`,
    `storage__${feature}__wraps`,
    `storage__${feature}__quarantinePath`,
    ...DECORATOR_WRAPPED_CONFIG_SUFFIXES.map(
      (suffix) => `storage__${feature}__wrappedConfig__${suffix}`
    ),
  ])
  .sort();

// The actual diff loop, factored out so the control case below can run it
// for real instead of asserting on hand-built objects that never pass
// through it.
function diffSharedKeys(
  infra: Readonly<Record<string, string | number | boolean>>,
  core: Readonly<Record<string, string | number | boolean>>,
  sharedKeys: readonly string[]
): Array<{ key: string; infra: unknown; core: unknown }> {
  const mismatched: Array<{ key: string; infra: unknown; core: unknown }> = [];
  for (const key of sharedKeys) {
    const infraValue = infra[key];
    const coreValue = core[key];
    if (infraValue !== coreValue) {
      mismatched.push({ key, infra: infraValue, core: coreValue });
    }
  }
  return mismatched;
}

describe('tenant-zero parity — a real key-by-key diff against infra/tenant, not a substring check', () => {
  it('every key name infra/tenant renders for blog is now also rendered by render-core', () => {
    const infra = INFRA_TENANT_BLOG_ENV;
    const core = renderCoreTenantZeroEnv();

    const infraKeys = Object.keys(infra).sort();
    const coreKeys = Object.keys(core).sort();

    const missingFromCore = infraKeys.filter((k) => !coreKeys.includes(k)).sort();
    const extraInCore = coreKeys.filter((k) => !infraKeys.includes(k));

    // The claim this test makes concrete: exactly the named gap keys are
    // missing, no more and no fewer -- a regression that dropped a fifth
    // key, or one that "fixed" this by dropping a gap key from the expected
    // list, would both fail here. And render-core's own decorator keys are
    // exactly the named additions, no more and no fewer -- a regression
    // that silently stopped rendering the decorator for one feature would
    // shrink this list without anyone having to notice a missing key by eye.
    expect(missingFromCore).toEqual(KNOWN_GAP_KEYS);
    expect(extraInCore.sort()).toEqual(EXTRA_IN_CORE_KEYS);

    // Every key both sides claim to render must carry the same value,
    // except the deliberate divergences named above — the actual parity
    // claim, checked, not merely counted. Gap keys are excluded too: core
    // never renders them at all, so comparing them would only prove the
    // gap again, not a value mismatch.
    const sharedKeys = infraKeys.filter(
      (k) => !KNOWN_GAP_KEYS.includes(k) && !KNOWN_DIVERGED_KEYS.includes(k)
    );
    const mismatched = diffSharedKeys(infra, core, sharedKeys);
    expect(mismatched).toEqual([]);
    // 22 keys matched at review time (35 infra keys minus the 11 gap keys
    // minus the 2 diverged keys).
    expect(sharedKeys.length).toBe(22);
    expect(infraKeys.length).toBe(35);
  });

  it('control case: re-running diffSharedKeys against a deliberately drifted snapshot catches the mismatch', () => {
    // Re-runs the same loop the test above trusts, not a hand-built
    // object compared by hand — proves the loop itself would go red on
    // real drift, not just that two literals differ.
    const infra = INFRA_TENANT_BLOG_ENV;
    const core = renderCoreTenantZeroEnv();
    const sharedKeys = Object.keys(infra)
      .sort()
      .filter((k) => !KNOWN_GAP_KEYS.includes(k) && !KNOWN_DIVERGED_KEYS.includes(k));

    const drifted: Record<string, string | number | boolean> = {
      ...infra,
      database__connection__host: 'drifted-host.invalid',
    };

    const mismatched = diffSharedKeys(drifted, core, sharedKeys);
    expect(mismatched).toEqual([
      {
        key: 'database__connection__host',
        infra: 'drifted-host.invalid',
        core: infra.database__connection__host,
      },
    ]);
  });

  it('the two named divergences are real and in the expected direction — the spool, not mx1 directly', () => {
    const core = renderCoreTenantZeroEnv();
    // GREEN: render-core points the bulk path at the host's own spool,
    // never at the old snapshot's direct-to-mx1 address.
    expect(core.bulkEmail__mailgun__baseUrl).toBe(MAIL_SPOOL_BASE_URL);
    expect(core.bulkEmail__mailgun__baseUrl).not.toBe(
      INFRA_TENANT_BLOG_ENV.bulkEmail__mailgun__baseUrl
    );
    // GREEN: mail__from is the bare sending address, not infra's prose display name.
    expect(core.mail__from).toBe('hello@blog.branchleft.co.uk');
    expect(core.mail__from).not.toBe(INFRA_TENANT_BLOG_ENV.mail__from);
  });
});
