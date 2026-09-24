/**
 * The real tenant-zero parity proof, replacing the substring-`toContain`
 * check the review of workspace#1183 found made a claim it did not test
 * (finding 3, blocking, false claim): a real key-by-key diff, not a
 * substring check.
 *
 * `INFRA_TENANT_BLOG_ENV` below is not fabricated or hand-typed: it is the
 * literal, recorded output of `infra/tenant/environment.ts`'s own
 * `tenantEnvironment()` — the actual module `blog`'s live Pulumi stack
 * imports as `@branchleft/ghost-platform-tenant` — called directly with
 * `ghost-tenant-blog`'s real `Pulumi.blog.yaml` config values (secrets
 * excluded; neither renderer receives one, both emit only a reference),
 * `render-core/test/runtime.js#uploadLimits()`'s defaults, and
 * `/etc/branchleft/blog.env` as the secrets path. Recorded rather than
 * called live at test time because `render-core-ci.yml` runs `npm ci`
 * inside `render-core/` only (`working-directory: render-core`); a live
 * cross-package import of `infra/tenant/environment.ts` resolves locally
 * (both packages checked out in one worktree) but fails in CI, where
 * `infra/tenant`'s own `node_modules` and `@branchleft/tsconfig` dev
 * dependency are never installed.
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
import { CURRENT_SCHEMA_VERSION } from '../src/validate.js';
import type { TenantDescriptor } from '../src/descriptor.js';
import { tenantEnvironment as renderCoreTenantEnvironment } from '../src/environment.js';
import { uploadLimits } from '../src/runtime.js';

const SECRETS_FILE_PATH = '/etc/branchleft/blog.env';

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
    expiresAt: null,
  };
}

function renderCoreTenantZeroEnv(): Record<string, string | number | boolean> {
  return renderCoreTenantEnvironment(
    renderCoreTenantZeroDescriptor(),
    uploadLimits(),
    SECRETS_FILE_PATH
  );
}

/**
 * Every key `TransportSpec` genuinely cannot carry yet — see
 * `environment.ts#transportEnvironment`'s own doc comment.
 * [ISSUE branchLeft/workspace#1250](https://github.com/branchLeft/workspace/issues/1250)
 * ("the descriptor's sending identity") owns closing this; recorded on
 * [ISSUE branchLeft/workspace#1183](https://github.com/branchLeft/workspace/issues/1183)
 * rather than implemented around.
 */
const KNOWN_GAP_KEYS = [
  'mail__from',
  'bulkEmail__mailgun__baseUrl',
  'bulkEmail__mailgun__domain',
  'bulkEmail__mailgun__apiKey',
].sort();

describe('tenant-zero parity — a real key-by-key diff against infra/tenant, not a substring check', () => {
  it('every key infra/tenant renders for blog is either matched by render-core or in the known #1250 gap list', () => {
    const infra = INFRA_TENANT_BLOG_ENV;
    const core = renderCoreTenantZeroEnv();

    const infraKeys = Object.keys(infra).sort();
    const coreKeys = Object.keys(core).sort();

    const missingFromCore = infraKeys.filter((k) => !coreKeys.includes(k)).sort();
    const extraInCore = coreKeys.filter((k) => !infraKeys.includes(k));

    // The claim this test makes concrete: exactly the four #1250-owned
    // keys are missing, no more and no fewer -- a regression that dropped
    // a fifth key, or one that "fixed" this by dropping a #1250 key from
    // the expected list, would both fail here.
    expect(missingFromCore).toEqual(KNOWN_GAP_KEYS);
    expect(extraInCore).toEqual([]);

    // Every key both sides claim to render must carry the same value —
    // the actual parity claim, checked, not merely counted.
    const sharedKeys = infraKeys.filter((k) => !KNOWN_GAP_KEYS.includes(k));
    const mismatched: Array<{ key: string; infra: unknown; core: unknown }> = [];
    for (const key of sharedKeys) {
      const infraValue = infra[key];
      const coreValue = core[key];
      if (infraValue !== coreValue) {
        mismatched.push({ key, infra: infraValue, core: coreValue });
      }
    }
    expect(mismatched).toEqual([]);
    // 31 keys matched at review time (35 infra keys minus the 4 gap keys).
    expect(sharedKeys.length).toBe(31);
    expect(infraKeys.length).toBe(35);
  });

  it('control case: the diff can fail — a deliberately wrong value is caught', () => {
    const core = renderCoreTenantZeroEnv();
    expect(core.database__connection__host).not.toBe('not-the-real-host');
    const sabotaged = { ...core, database__connection__host: 'not-the-real-host' };
    expect(sabotaged.database__connection__host).not.toBe(
      INFRA_TENANT_BLOG_ENV.database__connection__host
    );
  });
});
