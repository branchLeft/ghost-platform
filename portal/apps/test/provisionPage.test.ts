import { describe, expect, it } from 'vitest';
import {
  CONTENT_PANELS,
  ContactConfigError,
  PROGRESS_REFRESH_SECONDS,
  PROGRESS_STEPS,
  RESTATED_EXPECTATIONS,
  clampPanel,
  parseProspectContact,
  renderProvisioningPage,
} from '../src/frontdoor/provisionPage.js';

describe('renderProvisioningPage: named steps and user-paced content', () => {
  it('marks the step the demo is on: the first while CLAIMED, the second while PROVISIONING', () => {
    const claimed = renderProvisioningPage('CLAIMED', CONTACT, null)!.body;
    expect(claimed).toContain('data-step="ACTIVE">STEP_RECEIVED_LABEL');
    expect(claimed).toContain('data-step="TODO">STEP_MAKING_LABEL');
    const making = renderProvisioningPage('PROVISIONING', CONTACT, null)!.body;
    expect(making).toContain('data-step="DONE">STEP_RECEIVED_LABEL');
    expect(making).toContain('data-step="ACTIVE">STEP_MAKING_LABEL');
    expect(making).toContain('data-step="TODO">STEP_CHECKING_LABEL');
    expect(PROGRESS_STEPS).toHaveLength(3);
  });

  it('shows the first content panel by default and the next link to the second', () => {
    const body = renderProvisioningPage('PROVISIONING', CONTACT, null)!.body;
    expect(body).toContain(CONTENT_PANELS[0]!.heading);
    expect(body).not.toContain(CONTENT_PANELS[1]!.heading);
    expect(body).toContain('href="?panel=1"');
  });

  it('the last panel has no next link', () => {
    const body = renderProvisioningPage('PROVISIONING', CONTACT, null, 2)!.body;
    expect(body).toContain(CONTENT_PANELS[2]!.heading);
    expect(body).not.toContain('?panel=');
  });

  it('clamps a requested position into the range rather than showing an empty screen', () => {
    expect(clampPanel(-1)).toBe(0);
    expect(clampPanel(1.5)).toBe(0);
    expect(clampPanel(NaN)).toBe(0);
    expect(clampPanel(99)).toBe(CONTENT_PANELS.length - 1);
  });

  it('control: a provision that finishes instantly does not advance the content past the prospect pace', () => {
    // The prospect is on panel 0. The provision goes CLAIMED, PROVISIONING, LIVE
    // at once: the panel shown at each step is the one the prospect asked for.
    const stillHere = renderProvisioningPage('CLAIMED', CONTACT, null, 0)!.body;
    const madeAtOnce = renderProvisioningPage('PROVISIONING', CONTACT, null, 0)!.body;
    expect(stillHere).toContain(CONTENT_PANELS[0]!.heading);
    expect(madeAtOnce).toContain(CONTENT_PANELS[0]!.heading);
    expect(madeAtOnce).not.toContain(CONTENT_PANELS[1]!.heading);
    const live = renderProvisioningPage('LIVE', CONTACT, 'k7m.demo.example.test', 0)!.body;
    expect(live).not.toContain(CONTENT_PANELS[1]!.heading);
    expect(live).not.toContain(CONTENT_PANELS[2]!.heading);
  });

  it('completion restates the expectations whatever the content position', () => {
    for (const position of [0, 1, 2]) {
      const body = renderProvisioningPage('LIVE', CONTACT, 'k7m.demo.example.test', position)!.body;
      for (const text of RESTATED_EXPECTATIONS) expect(body).toContain(`<li>${text}</li>`);
    }
    expect(RESTATED_EXPECTATIONS).toHaveLength(3);
  });
});

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
