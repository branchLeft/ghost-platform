import { describe, expect, it } from 'vitest';
import { boundSender, senderBelongsToTenant } from '../../src/senderAuthorization.js';

// A credential bound to one From local part may send as that address and no
// other at its sender domain. See senderAuthorization.md#the-local-part-binding.

const DOMAIN = 'demo-mail.example.test';
const BOUND = 'demo-1';

describe('senderBelongsToTenant with a bound local part', () => {
  it('accepts the bound address, bare, with a display name, and in any case', () => {
    expect(senderBelongsToTenant(`${BOUND}@${DOMAIN}`, DOMAIN, BOUND)).toBe(true);
    expect(senderBelongsToTenant(`Slot <${BOUND}@${DOMAIN}>`, DOMAIN, BOUND)).toBe(true);
    expect(senderBelongsToTenant(`DEMO-1@${DOMAIN}`, DOMAIN, BOUND)).toBe(true);
    expect(senderBelongsToTenant(`${BOUND}@${DOMAIN}`, DOMAIN, 'Demo-1')).toBe(true);
  });

  it("refuses another slot's address at the same domain", () => {
    expect(senderBelongsToTenant(`demo-2@${DOMAIN}`, DOMAIN, BOUND)).toBe(false);
    expect(senderBelongsToTenant(`Slot <demo-2@${DOMAIN}>`, DOMAIN, BOUND)).toBe(false);
  });

  it('refuses an address that only extends or prefixes the bound one', () => {
    for (const local of ['demo-10', 'demo-1.x', 'demo-1+tag', 'xdemo-1', 'demo-', 'demo']) {
      expect(senderBelongsToTenant(`${local}@${DOMAIN}`, DOMAIN, BOUND), local).toBe(false);
    }
  });

  it('refuses a display name that spells the bound address in front of another address', () => {
    expect(senderBelongsToTenant(`"${BOUND}@${DOMAIN}" <demo-2@${DOMAIN}>`, DOMAIN, BOUND)).toBe(
      false
    );
  });

  it('needs every mailbox of a multi-address From to be the bound address', () => {
    expect(senderBelongsToTenant(`${BOUND}@${DOMAIN}, demo-2@${DOMAIN}`, DOMAIN, BOUND)).toBe(
      false
    );
    expect(senderBelongsToTenant(`${BOUND}@${DOMAIN}, ${BOUND}@${DOMAIN}`, DOMAIN, BOUND)).toBe(
      true
    );
  });

  it('still refuses a foreign domain for the bound local part', () => {
    expect(senderBelongsToTenant(`${BOUND}@evil.example`, DOMAIN, BOUND)).toBe(false);
  });

  it('leaves an unbound credential able to send as any local part (null, and the old two-argument call)', () => {
    expect(senderBelongsToTenant(`demo-2@${DOMAIN}`, DOMAIN, null)).toBe(true);
    expect(senderBelongsToTenant(`demo-2@${DOMAIN}`, DOMAIN)).toBe(true);
  });
});

describe('boundSender with a bound local part', () => {
  it('queues the bound address in the normal form', () => {
    expect(boundSender(`Slot <${BOUND}@${DOMAIN}>`, DOMAIN, undefined, BOUND)).toBe(
      `"Slot" <${BOUND}@${DOMAIN}>`
    );
  });

  it("refuses another slot's address and returns nothing to queue", () => {
    expect(boundSender(`demo-2@${DOMAIN}`, DOMAIN, undefined, BOUND)).toBeNull();
    expect(
      boundSender(`${BOUND}@${DOMAIN}, demo-2@${DOMAIN}`, DOMAIN, undefined, BOUND)
    ).toBeNull();
  });

  it('applies the binding to the header as written too (the SMTP header-From call)', () => {
    expect(boundSender(`${BOUND}@${DOMAIN}`, DOMAIN, `demo-2@${DOMAIN}`, BOUND)).toBe(
      `${BOUND}@${DOMAIN}`
    );
    expect(boundSender(`demo-2@${DOMAIN}`, DOMAIN, `${BOUND}@${DOMAIN}`, BOUND)).toBeNull();
  });

  it('refuses a quoted local part that unquotes to a different address', () => {
    expect(boundSender(`"demo-2"@${DOMAIN}`, DOMAIN, undefined, BOUND)).toBeNull();
    expect(boundSender(`"${BOUND}"@${DOMAIN}`, DOMAIN, undefined, BOUND)).toBe(
      `${BOUND}@${DOMAIN}`
    );
  });

  it('is unchanged for an unbound credential', () => {
    expect(boundSender(`demo-2@${DOMAIN}`, DOMAIN, undefined, null)).toBe(`demo-2@${DOMAIN}`);
    expect(boundSender(`demo-2@${DOMAIN}`, DOMAIN)).toBe(`demo-2@${DOMAIN}`);
  });
});
