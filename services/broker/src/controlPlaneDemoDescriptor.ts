/**
 * The control-plane half of a demo's provisioning (LLD-12 section 03,
 * CLAIMED): the demo descriptor built from a recorded request, through the
 * render core's own validation. It runs on ops1 in the lifecycle worker and
 * never on the demo host: nothing the host's bundle is built from imports it
 * (`controlPlaneDemoIsolation.test.ts`). See controlPlaneDemoDescriptor.md.
 */
import {
  CURRENT_SCHEMA_VERSION,
  validate,
  validateAbsoluteUrl,
  validateDigestPinnedRef,
  validateEmailAddress,
  validateInstant,
  validatePort,
  validatePrivateIpV4,
  validateSlug,
  validateTenantUid,
  type ResourceCaps,
  type SlotName,
  type TenantDescriptor,
  type ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
import { slotAllocation } from './slotPorts.js';

/**
 * Everything about the demo estate that is the same for every demo: where it
 * lives and the posture each demo is held to. Supplied by the worker's
 * configuration, never read from a request.
 */
export interface DemoEstate {
  readonly zones: ZoneConfig;
  /** The Ghost image, pinned by digest. */
  readonly image: string;
  readonly appHostIp: string;
  /** Allocated once at host build; the broker refuses a descriptor that disagrees. */
  readonly uidBase: number;
  readonly appPortBase: number;
  readonly healthPortBase: number;
  /** The directory each demo's database and media live under, per slot. */
  readonly dataRoot: string;
  /** The directory each demo's mail spool lives under, per slot. */
  readonly spoolRoot: string;
  readonly mail: { readonly ceiling: number; readonly estateCeiling: number };
  readonly limits: { readonly membersCap: number | null; readonly staffCap: number | null };
  readonly caps: ResourceCaps;
}

/** What one demo adds to the estate: its slot, its name, its owner, its end and its gate. */
export interface DemoDescriptorInput {
  readonly slot: SlotName;
  /** The demo's one hostname label from the register: random, never derived from the request. */
  readonly label: string;
  /** The address the identity service verified; the one address Ghost creates the owner account for. */
  readonly ownerEmail: string;
  /** The end of the term the database issued on entering PROVISIONING. Never computed here. */
  readonly expiresAt: Date;
  readonly argon2idHash: string;
}

/**
 * The demo descriptor for one slot, validated by render-core's `validate`
 * and so refused, by name, for anything the broker would refuse. The slot's
 * uid and ports come from the slot's own allocation (LLD-2 section 01), the
 * same arithmetic the broker checks a descriptor against.
 *
 * @throws FieldValidationError and InvariantViolationError from render-core
 */
export function buildDemoDescriptor(
  input: DemoDescriptorInput,
  estate: DemoEstate
): TenantDescriptor {
  const slotDirName = `demo-${input.slot}`;
  const allocation = slotAllocation(
    estate.uidBase,
    estate.appPortBase,
    estate.healthPortBase,
    input.slot
  );
  const root = estate.dataRoot.replace(/\/+$/, '');
  const spool = estate.spoolRoot.replace(/\/+$/, '');
  const descriptor: TenantDescriptor = {
    version: CURRENT_SCHEMA_VERSION,
    kind: 'demo',
    slug: validateSlug(slotDirName),
    siteUrl: validateAbsoluteUrl(`https://${input.label}.${estate.zones.demoZone}`),
    image: validateDigestPinnedRef(estate.image),
    ownerEmail: validateEmailAddress(input.ownerEmail, 'ownerEmail'),
    uid: validateTenantUid(allocation.uid),
    ports: {
      a: validatePort(allocation.ports.a, 'ports.a'),
      b: validatePort(allocation.ports.b, 'ports.b'),
      health: validatePort(allocation.ports.health, 'ports.health'),
    },
    appHostIp: validatePrivateIpV4(estate.appHostIp),
    database: { kind: 'sqlite', path: `${root}/${slotDirName}/ghost.db` },
    media: {
      kind: 'local',
      path: `${root}/${slotDirName}/content`,
      resize: false,
      srcsets: false,
    },
    transport: { kind: 'queue', path: `${spool}/${slotDirName}` },
    mail: {
      enabled: true,
      ceiling: estate.mail.ceiling,
      estateCeiling: estate.mail.estateCeiling,
      identity: { kind: 'demo', localPart: slotDirName },
    },
    hostname: { kind: 'ours', sub: input.label, gated: true },
    gate: { kind: 'passphrase', argon2idHash: input.argon2idHash },
    backup: { kind: 'none' },
    codeInjection: { kind: 'blocked' },
    breakGlass: { kind: 'disabled' },
    limits: { ...estate.limits },
    caps: { ...estate.caps },
    safety: { near: true, exact: true },
    expiresAt: validateInstant(input.expiresAt.toISOString(), 'expiresAt'),
  };
  return validate(descriptor, estate.zones);
}
