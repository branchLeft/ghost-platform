import { describe, expect, it } from 'vitest';
import { validate } from '@branchleft/ghost-platform-render-core';
import { buildDemoDescriptor } from '../../src/controlPlaneDemoDescriptor.js';
import { descriptorHash } from '../../src/descriptorHash.js';
import { slotAllocation } from '../../src/slotPorts.js';
import { ESTATE, OWNER } from '../helpers/demoProvisionRig.js';
import { TEST_ZONES } from '../helpers/fixtures.js';
import type { SlotName } from '@branchleft/ghost-platform-render-core';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';
const LABEL = 'k7mvalebrightq2w3e4r5';
const END = new Date('2026-12-01T10:00:00.000Z');

function build(slot = '3', overrides: Partial<Parameters<typeof buildDemoDescriptor>[0]> = {}) {
  return buildDemoDescriptor(
    {
      slot: slot as SlotName,
      label: LABEL,
      ownerEmail: OWNER,
      expiresAt: END,
      argon2idHash: HASH,
      ...overrides,
    },
    ESTATE
  );
}

describe('buildDemoDescriptor', () => {
  it('builds a demo descriptor the broker accepts, expiring exactly at the term it was given', () => {
    const descriptor = build();
    expect(descriptor.kind).toBe('demo');
    expect(descriptor.expiresAt).toBe('2026-12-01T10:00:00.000Z');
    expect(descriptor.ownerEmail).toBe(OWNER);
    expect(descriptor.siteUrl).toBe(`https://${LABEL}.${TEST_ZONES.demoZone}`);
    expect(descriptor.hostname).toEqual({ kind: 'ours', sub: LABEL, gated: true });
    expect(descriptor.gate).toEqual({ kind: 'passphrase', argon2idHash: HASH });
    // The broker's own validation, with the broker's own zones, agrees.
    expect(validate(descriptor, TEST_ZONES)).toBe(descriptor);
  });

  it("takes the slot's uid and ports from the slot's own allocation, as the broker checks them", () => {
    for (const slot of ['0', '1', '6']) {
      const descriptor = build(slot);
      const allocation = slotAllocation(30001, 9300, 10100, slot as SlotName);
      expect(descriptor.uid).toBe(allocation.uid);
      expect(descriptor.ports).toEqual(allocation.ports);
    }
  });

  it('names nothing after the prospect: the slug, paths and mail identity come from the slot alone', () => {
    const descriptor = build('2', { ownerEmail: 'zz9plural@alpha.example' });
    expect(descriptor.slug).toBe('demo-2');
    expect(descriptor.database).toEqual({ kind: 'sqlite', path: '/data/demo-2/ghost.db' });
    expect(descriptor.transport).toEqual({ kind: 'queue', path: '/var/spool/demo-2' });
    expect(descriptor.mail.identity).toEqual({ kind: 'demo', localPart: 'demo-2' });
    // The prospect's address appears once, as the owner, and in no name or path.
    expect(JSON.stringify(descriptor).split('zz9plural')).toHaveLength(2);
  });

  it('holds the demo posture: no backup, no code injection, no break-glass, the scanning axes on', () => {
    const descriptor = build();
    expect(descriptor.backup).toEqual({ kind: 'none' });
    expect(descriptor.codeInjection).toEqual({ kind: 'blocked' });
    expect(descriptor.breakGlass).toEqual({ kind: 'disabled' });
    expect(descriptor.safety).toEqual({ near: true, exact: true });
  });

  it('is deterministic: the same inputs hash the same, so a resend is the same request', () => {
    expect(descriptorHash(build())).toBe(descriptorHash(build()));
    expect(descriptorHash(build())).not.toBe(
      descriptorHash(build('3', { argon2idHash: `${HASH}x` }))
    );
  });

  it('refuses what render-core refuses, before anything is sent', () => {
    expect(() => build('3', { ownerEmail: 'not an address' })).toThrow();
    expect(() => build('3', { label: 'Not A Label' })).toThrow();
    expect(() => build('3', { expiresAt: new Date(Number.NaN) })).toThrow();
    expect(() => build('3', { argon2idHash: '   ' })).toThrow();
  });
});
