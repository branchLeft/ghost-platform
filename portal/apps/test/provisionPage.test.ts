import { describe, expect, it } from 'vitest';
import {
  ContactConfigError,
  PROGRESS_REFRESH_SECONDS,
  parseProspectContact,
  renderProvisioningPage,
} from '../src/frontdoor/provisionPage.js';

const CONTACT = { address: 'hello@example.test', bookingUrl: 'https://book.example.test/call' };

describe('renderProvisioningPage: FAILED', () => {
  const page = renderProvisioningPage('FAILED', CONTACT, null)!;

  it('says it failed, offers a real address and the bookable call together, and does not ask again', () => {
    expect(page.body).toContain('PROVISION_FAILED_HEADING');
    expect(page.body).toContain('PROVISION_FAILED_BODY');
    expect(page.body).toContain('href="mailto:hello@example.test"');
    expect(page.body).toContain('href="https://book.example.test/call"');
    expect(page.body).toContain('PROVISION_FAILED_BOOK_CALL_LABEL');
    expect(page.refreshSeconds).toBeNull();
  });

  it('is not a spinner: no progress wording and no refresh', () => {
    expect(page.body).not.toContain('PROVISIONING_');
    expect(page.refreshSeconds).toBeNull();
  });

  it('shows nothing of why or where: the hostname passed in is not rendered', () => {
    const withAddress = renderProvisioningPage(
      'FAILED',
      CONTACT,
      'k7mvalebright.demo.example.test'
    )!;
    expect(withAddress.body).toBe(page.body);
    expect(withAddress.body).not.toContain('k7mvalebright');
  });

  it('escapes the contact it is given', () => {
    const odd = renderProvisioningPage(
      'FAILED',
      { address: 'a&b@example.test', bookingUrl: 'https://book.example.test/?x=1&y="2"' },
      null
    )!;
    expect(odd.body).toContain('a&amp;b@example.test');
    expect(odd.body).not.toContain('"2"');
  });

  it('is not built without a real address and a bookable call: it throws rather than show half an offer', () => {
    expect(() => renderProvisioningPage('FAILED', { ...CONTACT, address: '' }, null)).toThrow(
      ContactConfigError
    );
    expect(() => renderProvisioningPage('FAILED', { ...CONTACT, bookingUrl: '' }, null)).toThrow(
      ContactConfigError
    );
  });
});

describe('renderProvisioningPage: the other states', () => {
  it('asks again while the demo is being made, and only then', () => {
    for (const state of ['CLAIMED', 'PROVISIONING']) {
      const page = renderProvisioningPage(state, CONTACT, null)!;
      expect(page.body).toContain('PROVISIONING_BODY');
      expect(page.refreshSeconds).toBe(PROGRESS_REFRESH_SECONDS);
    }
  });

  it('shows the demo address once LIVE, and stops asking', () => {
    const page = renderProvisioningPage('LIVE', CONTACT, 'k7m.demo.example.test')!;
    expect(page.body).toContain('DEMO_READY_HEADING');
    expect(page.body).toContain('href="https://k7m.demo.example.test/"');
    expect(page.refreshSeconds).toBeNull();
    expect(renderProvisioningPage('LIVE', CONTACT, null)!.body).toContain('DEMO_NO_ADDRESS_YET');
  });

  it('does not speak to a state it does not own', () => {
    for (const state of ['VERIFIED', 'WAITING', 'EXPIRING', 'PURGED', 'NOPE']) {
      expect(renderProvisioningPage(state, CONTACT, null)).toBeUndefined();
    }
  });
});

describe('parseProspectContact', () => {
  it('accepts a real address and an https booking link', () => {
    expect(parseProspectContact(CONTACT)).toEqual({
      address: 'hello@example.test',
      bookingUrl: 'https://book.example.test/call',
    });
  });

  it('refuses a booking link that is not https, carries credentials, or is not a link', () => {
    for (const bookingUrl of [
      'http://book.example.test',
      'https://u:p@book.example.test',
      'nope',
    ]) {
      expect(() => parseProspectContact({ ...CONTACT, bookingUrl })).toThrow(ContactConfigError);
    }
  });

  it('refuses an address that is not one', () => {
    for (const address of ['nope', 'a@b', 'a b@example.test', '<a@example.test>']) {
      expect(() => parseProspectContact({ ...CONTACT, address })).toThrow(ContactConfigError);
    }
  });
});
