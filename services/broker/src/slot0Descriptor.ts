/**
 * The demo slot 0 descriptor the owner's first lease carries. It is rendered here, validated by render-core's
 * own `validate()` against the zones the host runs with, and written to a
 * file the lease CLI sends. Narrative: slot0Lease.md.
 *
 * Everything that varies is an input the owner supplies at run time: the
 * image digest, the owner's address, the gate passphrase (hashed here, never
 * stored) and the expiry. Nothing personal or secret is committed.
 */
import { argon2, randomBytes } from 'node:crypto';
import {
  CURRENT_SCHEMA_VERSION,
  validate,
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
import { DEFAULT_APP_PORT_BASE, DEFAULT_HEALTH_PORT_BASE, DEFAULT_UID_BASE } from './config.js';
import { SLOT_IMAGE_REF } from './controlPlaneSlotImagePush.js';
import { slotAllocation } from './slotPorts.js';

/** The slot this descriptor is for. A slot's uid and ports come from its own allocation, never from input. */
export const SLOT0_NAME = '0';
/** Slot 0's one tenancy name. It becomes the public host `slot-0.<demo zone>`, so it is fixed and never a visitor's name. */
export const SLOT0_SLUG = 'slot-0';
/** The argon2id parameters new gate hashes are minted with: the same as services/demo-gate's DEFAULT_PARAMETERS. */
const GATE_MEMORY_KIB = 64 * 1024;
const GATE_PASSES = 3;
const GATE_PARALLELISM = 4;
const GATE_SALT_BYTES = 16;
const GATE_TAG_BYTES = 32;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class Slot0InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Slot0InputError';
  }
}

export interface Slot0DescriptorInput {
  /** `sha256:<64 lowercase hex>`: the manifest digest the slot image was pushed and attested under. */
  readonly imageDigest: string;
  /** The demo host's private address, supplied by the owner at run time. */
  readonly appHostIp: string;
  /** The demo owner's address. The broker creates the owner account from it. */
  readonly ownerEmail: string;
  /** An argon2id PHC string from `mintGateHash`. */
  readonly gateArgon2idHash: string;
  /** Non-null for a demo. ISO-8601 UTC with milliseconds, e.g. 2027-01-31T00:00:00.000Z. */
  readonly expiresAt: string;
  readonly zones: ZoneConfig;
}

/**
 * Builds slot 0's demo descriptor and validates it with render-core's own
 * `validate()`. Throws on any refusal, so a file is only ever written for a
 * descriptor the broker will accept on its own rules.
 */
export function renderSlot0Descriptor(input: Slot0DescriptorInput): TenantDescriptor {
  if (!DIGEST_PATTERN.test(input.imageDigest)) {
    throw new Slot0InputError('image digest must be sha256:<64 lowercase hex>');
  }
  const allocation = slotAllocation(
    DEFAULT_UID_BASE,
    DEFAULT_APP_PORT_BASE,
    DEFAULT_HEALTH_PORT_BASE,
    SLOT0_NAME as SlotName
  );
  const descriptor = {
    version: CURRENT_SCHEMA_VERSION,
    kind: 'demo',
    slug: SLOT0_SLUG as Slug,
    siteUrl: `https://${SLOT0_SLUG}.${input.zones.demoZone}` as AbsoluteUrl,
    image: `${SLOT_IMAGE_REF}@${input.imageDigest}` as DigestPinnedRef,
    ownerEmail: input.ownerEmail as EmailAddress,
    uid: allocation.uid as TenantUid,
    ports: {
      a: allocation.ports.a as Port,
      b: allocation.ports.b as Port,
      health: allocation.ports.health as Port,
    },
    appHostIp: input.appHostIp as PrivateIpV4,
    database: { kind: 'sqlite', path: `/data/${SLOT0_SLUG}/ghost.db` },
    media: {
      kind: 'local',
      path: `/data/${SLOT0_SLUG}/content`,
      resize: false,
      srcsets: false,
    },
    transport: { kind: 'queue', path: `/var/spool/${SLOT0_SLUG}` },
    // Mail is off: the first slot is inspected, not used to send anything.
    mail: {
      enabled: false,
      ceiling: 0,
      estateCeiling: 0,
      identity: { kind: 'demo', localPart: SLOT0_SLUG },
    },
    hostname: { kind: 'ours', sub: SLOT0_SLUG, gated: true },
    gate: { kind: 'passphrase', argon2idHash: input.gateArgon2idHash },
    backup: { kind: 'none' },
    codeInjection: { kind: 'blocked' },
    limits: { membersCap: 50, staffCap: 1 },
    caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
    safety: { near: true, exact: true },
    breakGlass: { kind: 'disabled' },
    expiresAt: input.expiresAt as Instant,
  };
  return validate(descriptor as TenantDescriptor, input.zones);
}

function unpaddedBase64(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '');
}

function deriveArgon2id(message: Buffer, nonce: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message,
        nonce,
        parallelism: GATE_PARALLELISM,
        tagLength: GATE_TAG_BYTES,
        memory: GATE_MEMORY_KIB,
        passes: GATE_PASSES,
      },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

/**
 * Mints the gate's argon2id PHC string for one passphrase. Only the hash is
 * returned: the passphrase is never written anywhere by this module. The
 * gate (services/demo-gate) verifies it with its own strict parser, so a
 * hash this function got wrong is refused there, not accepted.
 */
export async function mintGateHash(passphrase: string): Promise<string> {
  if (passphrase.length === 0) {
    throw new Slot0InputError('the gate passphrase is empty');
  }
  const salt = randomBytes(GATE_SALT_BYTES);
  const tag = await deriveArgon2id(Buffer.from(passphrase, 'utf8'), salt);
  return `$argon2id$v=19$m=${GATE_MEMORY_KIB},t=${GATE_PASSES},p=${GATE_PARALLELISM}$${unpaddedBase64(salt)}$${unpaddedBase64(tag)}`;
}
