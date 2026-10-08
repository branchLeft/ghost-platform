import type {
  TenantDescriptor,
  TenantStackDescriptor,
  ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
import type { GhostTenantSecrets } from '../index';

/** Test-only zones, in RFC 2606 reserved names, never a real estate domain. */
export const TEST_ZONES: ZoneConfig = {
  demoZone: 'demo-domain.example.test',
  platformZone: 'platform-domain.example.test',
  ownedDomains: ['demo-domain.example.test', 'platform-domain.example.test'],
  demoMailDomain: 'demo-mail.example.test',
};

const DIGEST = 'b'.repeat(64);

/**
 * A tenant-zero-equivalent paying tenant: the same shape of configuration
 * the live tenant-zero stack passes to the 4.0.0 component (MySQL, S3 media,
 * SMTP mail, bulk mail, default caps and upload limits), with placeholder
 * values. The slug is not tenant zero's own: see output-diff.md#the-slug.
 * No `ownerEmail`: it arrives as a secret, in `tenantZeroSecrets()`.
 */
export function tenantZeroEquivalent(): TenantStackDescriptor {
  return {
    version: 1,
    kind: 'tenant',
    slug: 'zero',
    siteUrl: 'https://zero.platform-domain.example.test',
    image: `ghcr.io/example/ghost-tenant@sha256:${DIGEST}`,
    uid: 30001,
    ports: { a: 8101, b: 8102, health: 8103 },
    appHostIp: '10.20.1.100',
    database: {
      kind: 'mysql',
      host: '10.20.1.20',
      port: 3306,
      name: 'ghost_zero',
      user: 'ghost_zero',
    },
    media: {
      kind: 's3',
      endpoint: 'https://objects.example.test',
      region: 'region-1',
      bucket: 'branchleft-media-zero',
      resize: true,
      srcsets: true,
    },
    transport: { kind: 'smtp', host: 'mx.example.test', port: 587, user: 'zero@example.test' },
    mail: {
      enabled: true,
      ceiling: 10000,
      estateCeiling: 10000,
      identity: { kind: 'tenant', domain: 'zero-mail.example.test', dkimSelector: 'bl' },
    },
    hostname: { kind: 'ours', sub: 'zero', gated: false },
    gate: { kind: 'none' },
    backup: { kind: 'bucket-native', encryptionRecipient: 'age1qplaceholderrecipientforzero' },
    codeInjection: { kind: 'blocked' },
    limits: { membersCap: null, staffCap: null },
    caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
    safety: { near: true, exact: true },
    breakGlass: { kind: 'disabled' },
    expiresAt: null,
  } as unknown as TenantStackDescriptor;
}

/** One placeholder per secret the tenant-zero-equivalent descriptor needs. */
export function tenantZeroSecrets(): GhostTenantSecrets {
  return {
    databasePassword: 'PLACEHOLDER_DB_PASSWORD',
    s3AccessKeyId: 'PLACEHOLDER_S3_KEY_ID',
    s3SecretAccessKey: 'PLACEHOLDER_S3_SECRET',
    mailPassword: 'PLACEHOLDER_MAIL_PASSWORD',
    bulkEmailApiKey: 'PLACEHOLDER_BULK_KEY',
    ownerEmail: 'owner@zero.platform-domain.example.test',
  };
}

/** A demo descriptor, for the falsifying test's promotion. */
export function demoDescriptor(): TenantDescriptor {
  return {
    version: 1,
    kind: 'demo',
    slug: 'demo-1',
    siteUrl: 'https://k7m-vale-bright.demo-domain.example.test',
    image: `ghcr.io/example/ghost-tenant@sha256:${DIGEST}`,
    ownerEmail: 'owner@example.com',
    uid: 30011,
    ports: { a: 3001, b: 3002, health: 3003 },
    appHostIp: '10.20.1.50',
    database: { kind: 'sqlite', path: '/data/demo-1/ghost.db' },
    media: { kind: 'local', path: '/data/demo-1/content', resize: false, srcsets: false },
    transport: { kind: 'queue', path: '/var/spool/demo-1' },
    mail: {
      enabled: true,
      ceiling: 20,
      estateCeiling: 500,
      identity: { kind: 'demo', localPart: 'demo-1' },
    },
    hostname: { kind: 'ours', sub: 'k7m-vale-bright', gated: true },
    gate: { kind: 'passphrase', argon2idHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' },
    backup: { kind: 'none' },
    codeInjection: { kind: 'blocked' },
    limits: { membersCap: 50, staffCap: 1 },
    caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
    safety: { near: true, exact: true },
    breakGlass: { kind: 'disabled' },
    expiresAt: '2026-09-30T00:00:00.000Z',
  } as unknown as TenantDescriptor;
}
