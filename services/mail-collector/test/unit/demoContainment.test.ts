import { describe, expect, it } from 'vitest';
import { createDemoCeilings } from '../../src/demoCeilings.js';
import {
  createDemoContainment,
  descriptorOwnerRecipients,
  type VerifiedRecipients,
} from '../../src/demoContainment.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';

const target = (extra: Partial<DrainTarget> = {}): DrainTarget => ({
  id: 'slot-a',
  baseUrl: 'http://127.0.0.1:1',
  route: 'mx1',
  demo: true,
  sendingDomain: 'demo.example',
  senderLocalPart: 'slot-one',
  ownerEmail: 'prospect@example.com',
  ...extra,
});

const ceilings = (estateCeiling = 100, defaultSlotCeiling = 10) =>
  createDemoCeilings({
    estateCeiling: { transactional: estateCeiling, bulk: estateCeiling },
    defaultSlotCeiling: { transactional: defaultSlotCeiling, bulk: defaultSlotCeiling },
    windowMs: 60_000,
  });

describe('the verified-recipient record a demo reads today: the descriptor owner address', () => {
  it("knows the prospect's own address, in any case", () => {
    expect(descriptorOwnerRecipients.isVerified(target(), 'prospect@example.com')).toBe(true);
    expect(descriptorOwnerRecipients.isVerified(target(), 'Prospect@Example.COM')).toBe(true);
  });

  it.each([
    ['another address', 'someone@example.com'],
    ['a plus-tagged variant', 'prospect+x@example.com'],
    ['a subdomain', 'prospect@mail.example.com'],
    ['a list that starts with it', 'prospect@example.com, victim@example.org'],
    ['a list that ends with it', 'victim@example.org,prospect@example.com'],
    ['a display name wrapped around it', 'Prospect <prospect@example.com>'],
    ['a trailing space', 'prospect@example.com '],
    ['a line break', 'prospect@example.com\nBcc: victim@example.org'],
    ['an empty string', ''],
  ])('refuses %s', (_label, address) => {
    expect(descriptorOwnerRecipients.isVerified(target(), address)).toBe(false);
  });

  it('knows nobody for a slot whose descriptor carried no owner address', () => {
    const { ownerEmail: _dropped, ...bare } = target();
    expect(descriptorOwnerRecipients.isVerified(bare, 'prospect@example.com')).toBe(false);
    expect(descriptorOwnerRecipients.isVerified(bare, '')).toBe(false);
  });
});

describe('the demo containment verdict', () => {
  const gate = (recipients: VerifiedRecipients = descriptorOwnerRecipients, c = ceilings()) =>
    createDemoContainment({ recipients, ceilings: c });

  it("admits the owner's mail and names the slot's own address on the demo domain as its From", () => {
    expect(gate().admit(target(), { id: 'm1', emailId: null, to: 'prospect@example.com' })).toEqual(
      {
        ok: true,
        from: 'slot-one@demo.example',
      }
    );
  });

  it('builds the From from the normalised demo domain', () => {
    const verdict = gate().admit(target({ sendingDomain: 'Demo.Example.' }), {
      id: 'm1',
      emailId: null,
      to: 'prospect@example.com',
    });
    expect(verdict).toEqual({ ok: true, from: 'slot-one@demo.example' });
  });

  it.each([
    ['no local part', { senderLocalPart: undefined }],
    ['no demo domain', { sendingDomain: undefined }],
    ['a demo domain that is not a hostname', { sendingDomain: 'demo example' }],
  ])('holds a message when the slot has %s, and takes no place', (_label, patch) => {
    const c = ceilings();
    const slot = { ...target(), ...patch } as DrainTarget;
    expect(
      createDemoContainment({ recipients: descriptorOwnerRecipients, ceilings: c }).admit(slot, {
        id: 'm1',
        emailId: null,
        to: 'prospect@example.com',
      })
    ).toEqual({ ok: false, action: 'hold', reason: 'identity-unknown' });
    expect(c.size).toBe(0);
  });

  it('refuses a recipient outside the record, permanently, and takes no place', () => {
    const c = ceilings();
    const verdict = gate(descriptorOwnerRecipients, c).admit(target(), {
      id: 'm1',
      emailId: null,
      to: 'victim@example.org',
    });
    expect(verdict).toMatchObject({
      ok: false,
      action: 'refuse',
      reason: 'recipient-not-verified',
      detail: { severity: 'permanent' },
    });
    expect(c.size).toBe(0);
  });

  it('reads a recipient record that is not the descriptor: whatever the record says is the rule', () => {
    const record: VerifiedRecipients = {
      isVerified: (_slot, address) => address === 'verified-through-the-portal@example.com',
    };
    const g = gate(record);
    expect(
      g.admit(target(), { id: 'm1', emailId: null, to: 'verified-through-the-portal@example.com' })
        .ok
    ).toBe(true);
    // Not even the descriptor's own owner address passes when the record does not hold it.
    expect(g.admit(target(), { id: 'm2', emailId: null, to: 'prospect@example.com' }).ok).toBe(
      false
    );
  });

  it("refuses past the slot's own ceiling, temporarily, so the owner's address is not suppressed", () => {
    const g = gate(descriptorOwnerRecipients, ceilings(100, 1));
    expect(g.admit(target(), { id: 'm1', emailId: null, to: 'prospect@example.com' }).ok).toBe(
      true
    );
    expect(
      g.admit(target(), { id: 'm2', emailId: null, to: 'prospect@example.com' })
    ).toMatchObject({
      ok: false,
      action: 'refuse',
      reason: 'slot-ceiling',
      detail: { severity: 'temporary' },
    });
  });

  it('admits a newsletter and a sign-in message for one slot independently, each on its own ceiling', () => {
    const g = gate(descriptorOwnerRecipients, ceilings(100, 1));
    const to = 'prospect@example.com';
    expect(g.admit(target(), { id: 'n1', emailId: 'campaign-1', to }).ok).toBe(true);
    expect(g.admit(target(), { id: 'n2', emailId: 'campaign-1', to })).toMatchObject({
      reason: 'slot-ceiling',
    });
    expect(g.admit(target(), { id: 's1', emailId: null, to }).ok).toBe(true);
    expect(g.admit(target(), { id: 's2', emailId: null, to })).toMatchObject({
      reason: 'slot-ceiling',
    });
  });

  it('counts an empty email id as sign-in mail, as the lanes do', () => {
    const g = gate(descriptorOwnerRecipients, ceilings(100, 1));
    const to = 'prospect@example.com';
    expect(g.admit(target(), { id: 'n1', emailId: 'campaign-1', to }).ok).toBe(true);
    expect(g.admit(target(), { id: 's1', emailId: '', to }).ok).toBe(true);
    expect(g.admit(target(), { id: 's2', emailId: null, to })).toMatchObject({
      reason: 'slot-ceiling',
    });
  });

  it("uses the slot's descriptor ceiling over the default", () => {
    const g = gate(descriptorOwnerRecipients, ceilings(100, 50));
    const slot = target({ mailCeiling: 1 });
    expect(g.admit(slot, { id: 'm1', emailId: null, to: 'prospect@example.com' }).ok).toBe(true);
    expect(g.admit(slot, { id: 'm2', emailId: null, to: 'prospect@example.com' })).toMatchObject({
      reason: 'slot-ceiling',
    });
  });

  it("stops every slot at the estate ceiling, each keyed on the slot's own identity", () => {
    const g = gate(descriptorOwnerRecipients, ceilings(2, 10));
    const a = target({ id: 'slot-a' });
    const b = target({ id: 'slot-b' });
    const c = target({ id: 'slot-c' });
    expect(g.admit(a, { id: 'm1', emailId: null, to: 'prospect@example.com' }).ok).toBe(true);
    expect(g.admit(b, { id: 'm1', emailId: null, to: 'prospect@example.com' }).ok).toBe(true);
    expect(g.admit(c, { id: 'm1', emailId: null, to: 'prospect@example.com' })).toMatchObject({
      reason: 'estate-ceiling',
    });
    expect(g.admit(a, { id: 'm2', emailId: null, to: 'prospect@example.com' })).toMatchObject({
      reason: 'estate-ceiling',
    });
  });

  it('a refusal and a verdict never carry an address', () => {
    const verdict = gate().admit(target(), { id: 'm1', emailId: null, to: 'victim@example.org' });
    const text = JSON.stringify(verdict);
    expect(text).not.toContain('victim');
    expect(text).not.toContain('prospect');
  });
});
