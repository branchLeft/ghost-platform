import {
  CURRENT_SCHEMA_VERSION,
  type AbsoluteUrl,
  type DigestPinnedRef,
  type EmailAddress,
  type Instant,
  type Port,
  type PrivateIpV4,
  type Slug,
  type SlotName,
  type TenantDescriptor,
  type TenantUid,
  type ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
import { slotAllocation } from '../../src/slotPorts.js';

const DIGEST = 'a'.repeat(64);

// The test harness's own fixed allocation (`testBroker.ts`'s `BrokerDeps`):
// uidBase 30001, appPortBase 9300, healthPortBase 9100. `demoDescriptor()`'s
// own default (slot "0") is exactly this base, so it matches slot "0" with
// no override; `descriptorForSlot` computes the same allocation for any
// other slot, so a fixture reconciled onto slot N never trips item 1's
// mismatch refusal by construction.
const UID_BASE = 30001;
const APP_PORT_BASE = 9300;
const HEALTH_PORT_BASE = 9100;

/** RFC 2606 example domains, matching `render-core/test/fixtures.ts`'s own convention. */
export const TEST_ZONES: ZoneConfig = {
  demoZone: 'demo-domain.example.test',
  platformZone: 'platform-domain.example.test',
  ownedDomains: ['demo-domain.example.test', 'platform-domain.example.test'],
};

export function demoDescriptor(overrides: Partial<TenantDescriptor> = {}): TenantDescriptor {
  return {
    version: CURRENT_SCHEMA_VERSION,
    kind: 'demo',
    slug: 'demo-1' as Slug,
    siteUrl: 'https://k7m-vale-bright.demo-domain.example.test' as AbsoluteUrl,
    image: `ghost:6.55.0-alpine@sha256:${DIGEST}` as DigestPinnedRef,
    ownerEmail: 'owner@example.com' as EmailAddress,
    // Slot "0"'s own derived allocation under the test harness's fixed
    // bases -- see `UID_BASE`/`APP_PORT_BASE`/`HEALTH_PORT_BASE` above.
    // `descriptorForSlot` computes the equivalent for any other slot.
    uid: 30001 as TenantUid,
    ports: { a: 9300 as Port, b: 9301 as Port, health: 9100 as Port },
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
    ...overrides,
  };
}

/**
 * `demoDescriptor()`, retargeted at a specific slot: its `uid` and `ports`
 * are overridden to that slot's own derived allocation (item 1), so a test
 * reconciling this descriptor onto slot `slot` is never refused for a
 * mismatch it did not mean to test.
 */
export function descriptorForSlot(
  slot: SlotName,
  overrides: Partial<TenantDescriptor> = {}
): TenantDescriptor {
  const allocation = slotAllocation(UID_BASE, APP_PORT_BASE, HEALTH_PORT_BASE, slot);
  return demoDescriptor({
    uid: allocation.uid as TenantUid,
    ports: {
      a: allocation.ports.a as Port,
      b: allocation.ports.b as Port,
      health: allocation.ports.health as Port,
    },
    ...overrides,
  });
}

/**
 * A valid *paying-tenant* descriptor -- the broker only ever reconciles
 * demos, so this exists to prove that check against a descriptor that is
 * genuinely valid by `validate()`'s own rules, not one that was going to be
 * refused for some other reason first.
 */
export function tenantDescriptorFixture(
  overrides: Partial<TenantDescriptor> = {}
): TenantDescriptor {
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
      bucket: 'branchleft-media-acme',
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
    ...overrides,
  };
}
