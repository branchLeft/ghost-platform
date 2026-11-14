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
import { MESSAGE_DELIMITER } from '../src/tenant/supportContext.js';
import { MAX_TICKETS_PER_WINDOW, WINDOW_SECONDS } from '../src/tenant/supportLimiter.js';
import { MAX_CONTACT_LENGTH, MAX_MESSAGE_CHARACTERS } from '../src/tenant/supportValidation.js';
import { Browser, serve, type Running } from './browser.js';
import { NOW } from './idp.js';
import {
  portalOn,
  postForm,
  settingsFor,
  signedIn,
  startMock,
  type RunningMock,
} from './promotionRig.js';
import { FAKE_CONTACT, FAKE_RECIPIENT, FAKE_SENDER, RecordingMailer } from './supportHarness.js';

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

beforeEach(async () => {
  mailer.sent.length = 0;
  mailer.failure = null;
  errorLines = [];
  // Each test starts in a fresh enquiry window: the limiter lives as long as the portal.
  now += WINDOW_SECONDS + 1;
  api = await startMock();
  app = await serve((origin) =>
    portalOn(
      origin,
      db,
      {
        clock: () => now,
        provisioning: settingsFor(api.baseUrl),
        support: { mailer, recipient: FAKE_RECIPIENT, sender: FAKE_SENDER },
      },
      errorLines
    )
  );
});

afterEach(async () => {
  await app.close();
  await api.close();
});

const enquiry = (message = 'MESSAGE_TEXT'): Record<string, string> => ({
  contact: FAKE_CONTACT,
  message,
});

describe('the Professional enquiry page', () => {
  it('shows a demo tenant a form with the contact and the message as its only inputs, and a navigation entry', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const page = await browser.request('/professional');
    expect(page.status).toBe(200);
    expect(page.body).toContain('PROFESSIONAL_ENQUIRY_TITLE');
    expect(page.body).toContain('NAV_PROFESSIONAL');
    expect(page.body).toContain('action="/professional/send"');
    const controls = [...page.body.matchAll(/<(input|textarea|select)\b[^>]*>/g)].map(
      (match) => match[0]
    );
    expect(controls).toHaveLength(2);
    expect(controls.find((tag) => tag.startsWith('<input'))).toContain('name="contact"');
    expect(controls.find((tag) => tag.startsWith('<input'))).toContain(
      `maxlength="${MAX_CONTACT_LENGTH}"`
    );
    expect(controls.find((tag) => tag.startsWith('<textarea'))).toContain('name="message"');
    expect(controls.find((tag) => tag.startsWith('<textarea'))).toContain(
      `maxlength="${MAX_MESSAGE_CHARACTERS}"`
    );
    expect(page.body).not.toContain('hidden');
    expect(page.body).not.toContain(TENANT_B);
    expect((await browser.request('/')).body).toContain('NAV_PROFESSIONAL');
  });

  it('shows a tenant that is not a demo a placeholder and no form', async () => {
    const browser = await signedIn(app.origin, ORG_A);
    const page = await browser.request('/professional');
    expect(page.body).toContain('NOT_FOR_THIS_TENANT');
    expect(page.body).not.toContain('/professional/send');
  });

  it.each([
    ['/professional/sent', 'ENQUIRY_SENT'],
    ['/professional/limited', 'ENQUIRY_LIMIT_REACHED'],
    ['/professional', 'PROFESSIONAL_ENQUIRY_TITLE'],
  ])('renders only ALL_CAPS placeholders as the visible text of %s', async (path, heading) => {
    const browser = await signedIn(app.origin, ORG_B);
    const page = await browser.request(path);
    const words = [...page.body.matchAll(/>([^<]*)</g)].flatMap((match) =>
      (match[1] ?? '').split(/\s+/).filter((word) => word !== '')
    );
    expect(words).toContain(heading);
    for (const word of words) expect(word, path).toMatch(/^[A-Z0-9_]+$/);
  });

  it('sends a request with no session to sign in', async () => {
    const reply = await new Browser(app.origin).request('/professional');
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
  });
});

describe('the Professional enquiry send', () => {
  it('sends one plain-text email with the session tenant in the body, and records nothing', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/professional/send', enquiry('HELLO_TEXT'));
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/professional/sent');
    expect(mailer.sent).toHaveLength(1);
    const [message] = mailer.sent;
    expect(message?.to).toBe(FAKE_RECIPIENT);
    expect(message?.from).toBe(FAKE_SENDER);
    expect(message?.replyTo).toBe(FAKE_CONTACT);
    expect(message?.subject).toBe(`PROFESSIONAL_ENQUIRY ${TENANT_B}`);
    expect(message?.body).toBe(
      `TENANT_ID: ${TENANT_B}\nSCREEN: PROFESSIONAL\n\n${MESSAGE_DELIMITER}\nHELLO_TEXT`
    );
    // The enquiry is the email: the provisioning API is never asked.
    expect(api.mock.store.listRequests(undefined)).toHaveLength(0);
    expect(errorLines).toEqual([]);
  });

  it('names the signed-in tenant whatever the query, the form or a header names, and sends no tenant name', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    await postForm(
      browser,
      app.origin,
      `/professional/send?tenant=${TENANT_A}&tenant_id=${TENANT_A}`,
      {
        ...enquiry(),
        tenant: TENANT_A,
        tenant_id: TENANT_A,
        tenant_name: 'TYPED_TENANT_NAME',
        TENANT_ID: TENANT_A,
      },
      { 'x-tenant-id': TENANT_A }
    );
    const [message] = mailer.sent;
    expect(message?.subject).toContain(TENANT_B);
    expect(message?.body).toContain(`TENANT_ID: ${TENANT_B}`);
    expect(message?.body).not.toContain(TENANT_A);
    expect(message?.body).not.toContain('TYPED_TENANT_NAME');
  });

  it.each([
    ['an invalid address', { contact: 'not-an-address', message: 'MESSAGE_TEXT' }],
    ['an address with a line break', { contact: 'a@b.example\nBcc: c@d.example', message: 'M' }],
    ['no message', { contact: FAKE_CONTACT, message: '   ' }],
    ['a message over the limit', enquiry('x'.repeat(MAX_MESSAGE_CHARACTERS + 1))],
    ['a message holding a NUL', enquiry('before\0after')],
  ])('refuses %s and sends nothing', async (_name, fields) => {
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/professional/send', fields);
    expect(reply.status).toBe(400);
    expect(reply.body).toBe('REFUSED');
    expect(mailer.sent).toHaveLength(0);
    expect(errorLines.join('\n')).toContain('SupportTicketError');
  });

  it('accepts a message of exactly the limit', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(
      browser,
      app.origin,
      '/professional/send',
      enquiry('x'.repeat(MAX_MESSAGE_CHARACTERS))
    );
    expect(reply.location).toBe('/professional/sent');
    expect(mailer.sent).toHaveLength(1);
  });

  it('refuses a tenant that is not a demo and sends nothing', async () => {
    const browser = await signedIn(app.origin, ORG_A);
    const reply = await postForm(browser, app.origin, '/professional/send', enquiry());
    expect(reply.status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
    expect(errorLines.join('\n')).toContain('PromotionError');
  });

  it('refuses a request with no session and sends nothing', async () => {
    const reply = await postForm(
      new Browser(app.origin),
      app.origin,
      '/professional/send',
      enquiry()
    );
    expect(reply.status).toBe(302);
    expect(reply.location).toBe('/login');
    expect(mailer.sent).toHaveLength(0);
  });

  it('refuses a post from another origin and sends nothing', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(
      browser,
      'https://other.example.org',
      '/professional/send',
      enquiry()
    );
    expect(reply.status).toBe(403);
    expect(mailer.sent).toHaveLength(0);
  });

  it('answers a refusal and logs the error name only when the mailer fails', async () => {
    mailer.failure = new Error('SECRET_SMTP_TEXT');
    const browser = await signedIn(app.origin, ORG_B);
    const reply = await postForm(browser, app.origin, '/professional/send', enquiry());
    expect(reply.status).toBe(400);
    expect(errorLines.join('\n')).toContain('SupportTicketError');
    expect(errorLines.join('\n')).not.toContain('SECRET_SMTP_TEXT');
  });

  it('stops at the same ceiling as a support ticket and sends nothing past it', async () => {
    const browser = await signedIn(app.origin, ORG_B);
    for (let sent = 0; sent < MAX_TICKETS_PER_WINDOW; sent += 1) {
      const reply = await postForm(browser, app.origin, '/professional/send', enquiry());
      expect(reply.location).toBe('/professional/sent');
    }
    const over = await postForm(browser, app.origin, '/professional/send', enquiry());
    expect(over.status).toBe(303);
    expect(over.location).toBe('/professional/limited');
    expect(mailer.sent).toHaveLength(MAX_TICKETS_PER_WINDOW);
  });
});

describe('the Professional enquiry without the mail settings', () => {
  it('answers 404 on its page and its action, and has no navigation entry', async () => {
    const bare = await serve((origin) =>
      portalOn(origin, db, { provisioning: settingsFor(api.baseUrl) }, [])
    );
    try {
      const browser = await signedIn(bare.origin, ORG_B);
      for (const path of ['/professional', '/professional/sent', '/professional/limited']) {
        expect((await browser.request(path)).status).toBe(404);
      }
      expect((await postForm(browser, bare.origin, '/professional/send', enquiry())).status).toBe(
        404
      );
      const home = (await browser.request('/')).body;
      expect(home).not.toContain('NAV_PROFESSIONAL');
      // The Essentials request does not depend on the mail settings.
      expect(home).toContain('NAV_ESSENTIALS');
    } finally {
      await bare.close();
    }
  });

  it('is unchanged when neither setting is given', async () => {
    const bare = await serve((origin) => portalOn(origin, db, {}, []));
    try {
      const home = (await (await signedIn(bare.origin, ORG_B)).request('/')).body;
      expect(home).not.toContain('NAV_PROFESSIONAL');
      expect(home).not.toContain('NAV_ESSENTIALS');
    } finally {
      await bare.close();
    }
  });
});
