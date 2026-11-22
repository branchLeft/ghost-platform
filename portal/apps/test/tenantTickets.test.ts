import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import {
  createFixture,
  ORG_A,
  ORG_B,
  TENANT_A,
  TENANT_B,
  type Fixture,
} from '../../data/test/helpers.js';
import { MAX_TICKETS_PER_WINDOW, WINDOW_SECONDS } from '../src/tenant/supportLimiter.js';
import { serve, type Running } from './browser.js';
import { NOW } from './idp.js';
import {
  CREDENTIAL_A,
  deadBaseUrl,
  portalOn,
  postForm,
  settingsFor,
  signedIn,
  startMock,
  type RunningMock,
} from './promotionRig.js';
import { FAKE_CONTACT, FAKE_RECIPIENT, FAKE_SENDER, RecordingMailer } from './supportHarness.js';

/**
 * Every contact request the customer portal sends is also held, as a ticket, by
 * the provisioning API. The mail stays the delivery: these tests read the mock's
 * store as the owner's list and the mailer as the delivery.
 */
let fixture: Fixture;
let db: TenantDb;
let api: RunningMock;
let app: Running;
let now = NOW;
const mailer = new RecordingMailer();
let errorLines: string[] = [];

beforeAll(async () => {
  fixture = await createFixture();
  db = new TenantDb(fixture.tenant);
});

afterAll(async () => {
  await fixture.close();
});

async function start(baseUrl?: string, credentials?: Record<string, string>): Promise<void> {
  api = await startMock();
  errorLines = [];
  const settings = settingsFor(baseUrl ?? api.baseUrl);
  const provisioning =
    credentials === undefined
      ? settings
      : { ...settings, credentialFor: (tenant: string) => credentials[tenant] };
  app = await serve((origin) =>
    portalOn(
      origin,
      db,
      {
        clock: () => now,
        provisioning,
        support: { mailer, recipient: FAKE_RECIPIENT, sender: FAKE_SENDER },
      },
      errorLines
    )
  );
}

beforeEach(async () => {
  mailer.sent.length = 0;
  mailer.failure = null;
  // Each test starts in a fresh limiter window: the limiter lives as long as the portal.
  now += WINDOW_SECONDS + 1;
  await start();
});

afterEach(async () => {
  await app.close();
  await api.close();
});

const tickets = () => api.mock.store.listTickets(undefined, undefined);
const form = (message = 'MESSAGE_TEXT'): Record<string, string> => ({
  contact: FAKE_CONTACT,
  message,
});

describe('a contact request is held as a ticket as well as sent', () => {
  it('holds a support ticket for the signed-in tenant, in state new, and sends its mail', async () => {
    const browser = await signedIn(app.origin, ORG_A);
    const reply = await postForm(browser, app.origin, '/support/send', form('SUPPORT_TEXT'));
    expect(reply.location).toBe('/support/sent');
    expect(mailer.sent).toHaveLength(1);
    const [only, ...rest] = tickets();
    expect(rest).toHaveLength(0);
    expect(only).toMatchObject({
      tenant_id: TENANT_A,
      kind: 'support',
      state: 'new',
      contact: FAKE_CONTACT,
      message: 'SUPPORT_TEXT',
      request_id: null,
    });
    expect(errorLines).toEqual([]);
  });

  it('holds a Professional enquiry, in state new, and sends its mail', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/professional/send', form('ENQUIRY_TEXT'));
    expect(reply.location).toBe('/professional/sent');
    expect(mailer.sent).toHaveLength(1);
    expect(tickets()).toMatchObject([
      {
        tenant_id: TENANT_B,
        kind: 'professional-enquiry',
        state: 'new',
        contact: FAKE_CONTACT,
        message: 'ENQUIRY_TEXT',
      },
    ]);
    // The enquiry is not a promotion request: the owner's approval queue is as it was.
    expect(api.mock.store.listRequests(undefined)).toHaveLength(0);
    expect(errorLines).toEqual([]);
  });

  it('holds an Essentials request, in state new, linked to its promotion request', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/essentials/request');
    expect(reply.location).toBe('/essentials/sent');
    const [request] = api.mock.store.listRequests(undefined);
    expect(tickets()).toMatchObject([
      {
        tenant_id: TENANT_B,
        kind: 'essentials',
        state: 'new',
        contact: null,
        message: null,
        request_id: request?.request_id,
      },
    ]);
    expect(mailer.sent).toHaveLength(0);
  });

  it('shows the owner all three kinds, from both tenants, oldest first', async () => {
    const one = await signedIn(app.origin, ORG_A);
    const two = await signedIn(app.origin, ORG_B);
    await postForm(one, app.origin, '/support/send', form());
    await postForm(two, app.origin, '/professional/send', form());
    await postForm(two, app.origin, '/essentials/request');
    const held = tickets();
    expect(held.map((ticket) => ticket.kind)).toEqual([
      'support',
      'professional-enquiry',
      'essentials',
    ]);
    expect(held.map((ticket) => ticket.tenant_id)).toEqual([TENANT_A, TENANT_B, TENANT_B]);
    expect(held.every((ticket) => ticket.state === 'new')).toBe(true);
  });

  it('names the tenant the session is bound to, whatever the form or the query names', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    await postForm(
      browser,
      app.origin,
      `/support/send?tenant=${TENANT_A}`,
      { ...form(), tenant: TENANT_A, tenant_id: TENANT_A, kind: 'essentials', state: 'closed' },
      { 'x-tenant-id': TENANT_A }
    );
    expect(tickets()).toMatchObject([{ tenant_id: TENANT_B, kind: 'support', state: 'new' }]);
  });

  it('presents the credential issued for the session tenant and no other', async () => {
    // Only tenant A has a credential: tenant B's ticket must not be held with it.
    await app.close();
    await api.close();
    await start(undefined, { [TENANT_A]: CREDENTIAL_A });
    const browser = await signedIn(app.origin, ORG_B);
    await postForm(browser, app.origin, '/support/send', form());
    expect(tickets()).toEqual([]);
    expect(mailer.sent).toHaveLength(1);
    expect(errorLines.join('\n')).toContain('TicketRecordError');
  });
});

describe('a ticket that is not held never fails the request or its mail', () => {
  it('still sends the mail and lands on the sent page when the API cannot be reached', async () => {
    await app.close();
    await api.close();
    await start(await deadBaseUrl());
    const browser = await signedIn(app.origin, ORG_A);
    const reply = await postForm(browser, app.origin, '/support/send', form());
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/support/sent');
    expect(mailer.sent).toHaveLength(1);
    expect(tickets()).toEqual([]);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain('TicketRecordError');
    expect(errorLines[0]).not.toContain('MESSAGE_TEXT');
    expect(errorLines[0]).not.toContain(FAKE_CONTACT);
  });

  it('does the same for a Professional enquiry', async () => {
    await app.close();
    await api.close();
    await start(await deadBaseUrl());
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/professional/send', form());
    expect(reply.location).toBe('/professional/sent');
    expect(mailer.sent).toHaveLength(1);
    expect(errorLines.join('\n')).toContain('TicketRecordError');
  });

  it('still sends the mail when the tenant holds the most open tickets the API allows', async () => {
    for (let n = 0; n < 50; n += 1) {
      api.mock.store.createTicket(TENANT_A, 'support', { contact: FAKE_CONTACT, message: 'M' });
    }
    const browser = await signedIn(app.origin, ORG_A);
    const reply = await postForm(browser, app.origin, '/support/send', form());
    expect(reply.location).toBe('/support/sent');
    expect(mailer.sent).toHaveLength(1);
    expect(tickets()).toHaveLength(50);
    expect(errorLines.join('\n')).toContain('TicketRecordError');
  });
});

describe('a request that is not sent is not held', () => {
  it.each([
    ['an invalid address', { contact: 'not-an-address', message: 'MESSAGE_TEXT' }],
    ['no message', { contact: FAKE_CONTACT, message: '   ' }],
  ])('holds nothing for %s', async (_name, fields) => {
    const browser = await signedIn(app.origin, ORG_A);
    const reply = await postForm(browser, app.origin, '/support/send', fields);
    expect(reply.status).toBe(400);
    expect(tickets()).toEqual([]);
  });

  it('holds nothing when the mailer fails', async () => {
    mailer.failure = new Error('SECRET_SMTP_TEXT');
    const browser = await signedIn(app.origin, ORG_A);
    const reply = await postForm(browser, app.origin, '/support/send', form());
    expect(reply.status).toBe(400);
    expect(tickets()).toEqual([]);
  });

  it('holds nothing past the limit that stops the mail', async () => {
    const browser = await signedIn(app.origin, ORG_A);
    for (let sent = 0; sent < MAX_TICKETS_PER_WINDOW; sent += 1) {
      await postForm(browser, app.origin, '/support/send', form());
    }
    const over = await postForm(browser, app.origin, '/support/send', form());
    expect(over.location).toBe('/support/limited');
    expect(mailer.sent).toHaveLength(MAX_TICKETS_PER_WINDOW);
    expect(tickets()).toHaveLength(MAX_TICKETS_PER_WINDOW);
  });
});
