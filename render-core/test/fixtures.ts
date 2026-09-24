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
import type { TenantDescriptor } from '../src/descriptor.js';
import { CURRENT_SCHEMA_VERSION, type ZoneConfig } from '../src/validate.js';

// Not derived through the branding validators — these fixtures are meant to
// be valid by construction, so `validate()`'s own tests are what exercise
// the validators, not the fixtures that feed them.
const DIGEST = 'a'.repeat(64);

/**
 * Test-only zones, in the example.test-style names `RFC 2606` reserves for
 * exactly this — never a real platform or estate domain. The demo and
 * platform zones are deliberately different registrable domains, matching
 * the design's own separate-registration split, and both are owned.
 */
export const TEST_ZONES: ZoneConfig = {
  demoZone: 'demo-domain.example.test',
  platformZone: 'platform-domain.example.test',
  ownedDomains: ['demo-domain.example.test', 'platform-domain.example.test'],
};

export function demoDescriptor(): TenantDescriptor {
  return {
    version: CURRENT_SCHEMA_VERSION,
    kind: 'demo',
    slug: 'demo-1' as Slug,
    siteUrl: 'https://k7m-vale-bright.demo-domain.example.test' as AbsoluteUrl,
    image: `ghost:6.55.0-alpine@sha256:${DIGEST}` as DigestPinnedRef,
    ownerEmail: 'owner@example.com' as EmailAddress,
    uid: 30001 as TenantUid,
    ports: { a: 3001 as Port, b: 3002 as Port, health: 3003 as Port },
    appHostIp: '10.20.1.50' as PrivateIpV4,
    database: { kind: 'sqlite', path: '/data/demo-1/ghost.db' },
    media: { kind: 'local', path: '/data/demo-1/content', resize: false, srcsets: false },
    transport: { kind: 'queue', path: '/var/spool/demo-1' },
    hostname: { kind: 'ours', sub: 'k7m-vale-bright', gated: true },
    gate: { kind: 'passphrase', argon2idHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' },
    backup: { kind: 'none' },
    codeInjection: { kind: 'blocked' },
    limits: { membersCap: 50, staffCap: 1 },
    caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
    safety: { near: true, exact: true },
    expiresAt: '2026-09-30T00:00:00.000Z' as Instant,
  };
}

export function tenantDescriptor(): TenantDescriptor {
  return {
    version: CURRENT_SCHEMA_VERSION,
    kind: 'tenant',
    slug: 'acme' as Slug,
    siteUrl: 'https://blog.acme.example' as AbsoluteUrl,
    image: `ghost:6.55.0-alpine@sha256:${DIGEST}` as DigestPinnedRef,
    ownerEmail: 'owner@acme.example' as EmailAddress,
    uid: 30123 as TenantUid,
    ports: { a: 3101 as Port, b: 3102 as Port, health: 3103 as Port },
    appHostIp: '10.20.2.10' as PrivateIpV4,
    database: {
      kind: 'mysql',
      host: 'db-t1.internal',
      port: 3306 as Port,
      name: 'ghost_acme',
      user: 'ghost_acme',
    },
    media: {
      kind: 's3',
      endpoint: 'https://s3.endpoint.example',
      region: 'eu',
      bucket: 'acme-media',
      resize: true,
      srcsets: true,
    },
    transport: { kind: 'queue', path: '/var/spool/acme' },
    hostname: {
      kind: 'theirs',
      fqdn: 'blog.acme.example',
      verifiedAt: '2026-09-01T00:00:00.000Z' as Instant,
    },
    gate: { kind: 'none' },
    backup: { kind: 'bucket-native', encryptionRecipient: 'age1qtenantacmeexamplerecipient' },
    codeInjection: { kind: 'blocked' },
    limits: { membersCap: null, staffCap: null },
    caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
    safety: { near: true, exact: true },
    expiresAt: null,
  };
}

/**
 * A paying tenant on the entry tier: capped members/staff, the smaller
 * resource caps, `smtp` transport (so `render()`'s smtp branch has a golden
 * case distinct from `tenantDescriptor()`'s `queue`). `media.bucket`
 * matches `mediaBucketName(slug)` — `render()`'s own isolation check,
 * unlike `tenantDescriptor()` above, which predates it and is left alone
 * so `validate.test.ts` (which never calls `render()`) is unaffected.
 */
export function entryTenantDescriptor(): TenantDescriptor {
  return {
    version: CURRENT_SCHEMA_VERSION,
    kind: 'tenant',
    slug: 'entry-co' as Slug,
    siteUrl: 'https://blog.entry-co.example' as AbsoluteUrl,
    image: `ghost:6.55.0-alpine@sha256:${DIGEST}` as DigestPinnedRef,
    ownerEmail: 'owner@entry-co.example' as EmailAddress,
    uid: 30201 as TenantUid,
    ports: { a: 3201 as Port, b: 3202 as Port, health: 3203 as Port },
    appHostIp: '10.20.2.20' as PrivateIpV4,
    database: {
      kind: 'mysql',
      host: 'db-t1.internal',
      port: 3306 as Port,
      name: 'ghost_entry_co',
      user: 'ghost_entry_co',
    },
    media: {
      kind: 's3',
      endpoint: 'https://s3.endpoint.example',
      region: 'eu',
      bucket: 'branchleft-media-entry-co',
      resize: false,
      srcsets: false,
    },
    transport: { kind: 'smtp', host: 'mx.internal', port: 587 as Port, user: 'entry-co' },
    hostname: {
      kind: 'theirs',
      fqdn: 'blog.entry-co.example',
      verifiedAt: '2026-09-01T00:00:00.000Z' as Instant,
    },
    gate: { kind: 'none' },
    backup: { kind: 'bucket-native', encryptionRecipient: 'age1qentrycoexamplerecipient' },
    codeInjection: { kind: 'blocked' },
    limits: { membersCap: 500, staffCap: 3 },
    caps: { cpus: '0.5', cpuShares: 256, pidsLimit: 128, nofile: 2048 },
    safety: { near: true, exact: true },
    expiresAt: null,
  };
}

/**
 * A paying tenant on the professional tier: uncapped members/staff, the
 * larger resource caps, and a `managed` code-injection grant — the one
 * fixture that exercises `settings.ts`'s non-empty `codeinjection_head`/
 * `codeinjection_foot` branch.
 */
export function professionalTenantDescriptor(): TenantDescriptor {
  return {
    version: CURRENT_SCHEMA_VERSION,
    kind: 'tenant',
    slug: 'pro-co' as Slug,
    siteUrl: 'https://news.pro-co.example' as AbsoluteUrl,
    image: `ghost:6.55.0-alpine@sha256:${DIGEST}` as DigestPinnedRef,
    ownerEmail: 'owner@pro-co.example' as EmailAddress,
    uid: 30301 as TenantUid,
    ports: { a: 3301 as Port, b: 3302 as Port, health: 3303 as Port },
    appHostIp: '10.20.2.30' as PrivateIpV4,
    database: {
      kind: 'mysql',
      host: 'db-t1.internal',
      port: 3306 as Port,
      name: 'ghost_pro_co',
      user: 'ghost_pro_co',
    },
    media: {
      kind: 's3',
      endpoint: 'https://s3.endpoint.example',
      region: 'eu',
      bucket: 'branchleft-media-pro-co',
      resize: true,
      srcsets: true,
    },
    transport: { kind: 'smtp', host: 'mx.internal', port: 587 as Port, user: 'pro-co' },
    hostname: {
      kind: 'theirs',
      fqdn: 'news.pro-co.example',
      verifiedAt: '2026-08-15T00:00:00.000Z' as Instant,
    },
    gate: { kind: 'none' },
    backup: { kind: 'bucket-native', encryptionRecipient: 'age1qprocoexamplerecipient' },
    codeInjection: {
      kind: 'managed',
      head: '<meta name="analytics-consent" content="required">',
      foot: '<script src="/analytics.js" defer></script>',
    },
    limits: { membersCap: null, staffCap: null },
    caps: { cpus: '2.0', cpuShares: 1024, pidsLimit: 512, nofile: 8192 },
    safety: { near: true, exact: true },
    expiresAt: null,
  };
}
