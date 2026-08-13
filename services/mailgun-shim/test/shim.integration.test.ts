import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Interfaces } from 'mailgun.js';
import { createMailgunClient } from './helpers/mailgunClient.js';
import { startSmtpSink, type SmtpSink } from './helpers/smtpSink.js';
import { startTestShim, type TestShim } from './helpers/testServer.js';

// mailgun.js is the exact client library Ghost bundles
// (mailgun-client.js:367-370 constructs it the same way: `new
// Mailgun(formData)`, then `.client({username, key, url, timeout})`).
// Driving the shim through this library rather than hand-building
// multipart requests means the test exercises the real wire format, not a
// guess at it.

const TENANT_DOMAIN = 'tenant1.example.com';
const TENANT_API_KEY = 'test-tenant-1-api-key';
const SMTP_USER = 'shim-submission-user';
const SMTP_PASS = 'shim-submission-pass';

describe('mailgun-shaped shim', () => {
  let sink: SmtpSink;
  let shim: TestShim;
  let mailgunClient: Interfaces.IMailgunClient;

  beforeEach(async () => {
    sink = await startSmtpSink(SMTP_USER, SMTP_PASS);
    shim = await startTestShim(sink.port, SMTP_USER, SMTP_PASS);
    shim.store.registerTenant(TENANT_DOMAIN, TENANT_API_KEY);

    mailgunClient = createMailgunClient(shim.baseUrl, TENANT_API_KEY);
  });

  afterEach(async () => {
    await shim.close();
    await sink.close();
  });

  it('accepts a Ghost-shaped bulk send, delivers it over SMTP with recipient batching and email-id correlation intact', async () => {
    // Shaped exactly like MailgunClient#send's messageData
    // (mailgun-client.js:63-92): recipient-variables personalisation,
    // %recipient.*% tokens, the v:email-id correlation value, and the
    // fixed Auto-Submitted/List-Unsubscribe headers Ghost always sends.
    const recipientData = {
      'member-a@example.com': {
        name: 'Member A',
        unsubscribe_url: 'https://tenant1.example.com/unsubscribe/a',
        list_unsubscribe: 'https://tenant1.example.com/unsubscribe/a',
      },
      'member-b@example.com': {
        name: 'Member B',
        unsubscribe_url: 'https://tenant1.example.com/unsubscribe/b',
        list_unsubscribe: 'https://tenant1.example.com/unsubscribe/b',
      },
    };

    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: Object.keys(recipientData),
      from: 'TENANT_1 <noreply@tenant1.example.com>',
      'h:Reply-To': 'replies@tenant1.example.com',
      subject: 'Hello %recipient.name%',
      html: '<p>Hi %recipient.name%, <a href="%recipient.unsubscribe_url%">unsubscribe</a></p>',
      text: 'Hi %recipient.name%, unsubscribe: %recipient.unsubscribe_url%',
      'recipient-variables': JSON.stringify(recipientData),
      'h:Sender': 'noreply@tenant1.example.com',
      'h:Auto-Submitted': 'auto-generated',
      'h:X-Auto-Response-Suppress': 'OOF, AutoReply',
      'h:List-Unsubscribe': '<%recipient.list_unsubscribe%>',
      'h:List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'v:email-id': 'email-record-42',
      'o:tag': ['bulk-email', 'ghost-email'],
    });

    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(2);
    const byRecipient = new Map(received.map((m) => [m.envelopeTo[0], m]));

    const toA = byRecipient.get('member-a@example.com');
    const toB = byRecipient.get('member-b@example.com');
    expect(toA).toBeDefined();
    expect(toB).toBeDefined();

    // Recipient batching: each recipient got their own message rather than
    // a single email addressed to both (which would leak each member's
    // address to the other and break per-recipient unsubscribe links).
    expect(toA!.parsed.subject).toBe('Hello Member A');
    expect(toB!.parsed.subject).toBe('Hello Member B');
    expect(toA!.parsed.html).toContain('unsubscribe/a');
    expect(toB!.parsed.html).toContain('unsubscribe/b');

    // Correlation: v:email-id survives to the delivery host as a header.
    expect(toA!.parsed.headers.get('x-ghost-email-id')).toBe('email-record-42');

    // The events endpoint then reflects the send, with the same
    // email-id/message-id pair Ghost's normalizeEvent() requires
    // (mailgun-client.js:304-328) to associate an event back to an email.
    const page = await mailgunClient.events.get(TENANT_DOMAIN, {
      event: 'delivered OR failed',
      limit: 10,
    });
    expect(page.items.length).toBe(2);
    for (const item of page.items as unknown as Array<{
      event: string;
      'user-variables': { 'email-id': string };
      message: { headers: { 'message-id': string } };
    }>) {
      expect(item.event).toBe('delivered');
      expect(item['user-variables']['email-id']).toBe('email-record-42');
      expect(item.message.headers['message-id']).toBeTruthy();
    }
  });

  it('paginates events using the cursor mailgun.js extracts from paging.next', async () => {
    for (let i = 0; i < 5; i += 1) {
      shim.store.recordEvent({
        domain: TENANT_DOMAIN,
        type: 'delivered',
        severity: null,
        recipient: `member-${i}@example.com`,
        emailId: `email-${i}`,
        providerMessageId: `<msg-${i}@${TENANT_DOMAIN}>`,
        timestamp: Date.now() / 1000,
        errorCode: null,
        errorMessage: null,
      });
    }

    // Mirrors Ghost's own #fetchEventsFromDomain loop (mailgun-client.js:214-270):
    // fetch a page, then follow page.pages.next.page until items is empty.
    const seen = new Set<string>();
    let page = await mailgunClient.events.get(TENANT_DOMAIN, { limit: 2 });
    let guard = 0;
    while (page.items.length > 0 && guard < 10) {
      for (const item of page.items as unknown as Array<{ recipient: string }>) {
        seen.add(item.recipient);
      }
      const nextPageId = (page.pages as unknown as { next: { page: string } }).next.page;
      page = await mailgunClient.events.get(TENANT_DOMAIN, { limit: 2, page: nextPageId });
      guard += 1;
    }

    expect(seen.size).toBe(5);
  });

  it('un-suppresses via DELETE /v3/{domain}/{type}/{email} and re-enables sending', async () => {
    shim.store.addSuppression(TENANT_DOMAIN, 'bounces', 'bounced@example.com');

    const recipientData = { 'bounced@example.com': { name: 'Bounced Member' } };
    await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['bounced@example.com'],
      from: 'TENANT_1 <noreply@tenant1.example.com>',
      subject: 'Should be suppressed',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': JSON.stringify(recipientData),
    });

    // Give the async delivery path a moment to (not) run.
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.messages).toHaveLength(0);

    const result = await mailgunClient.suppressions.destroy(
      TENANT_DOMAIN,
      'bounces',
      'bounced@example.com'
    );
    expect(result.status).toBe(200);
    expect(shim.store.isSuppressed(TENANT_DOMAIN, 'bounces', 'bounced@example.com')).toBe(false);

    await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['bounced@example.com'],
      from: 'TENANT_1 <noreply@tenant1.example.com>',
      subject: 'Should send now',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': JSON.stringify(recipientData),
    });

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.subject).toBe('Should send now');
  });

  it('rejects an unknown API key the way Ghost treats an auth failure', async () => {
    const badClient = createMailgunClient(shim.baseUrl, 'not-a-real-key');

    await expect(
      badClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: 'noreply@tenant1.example.com',
        subject: 'x',
        html: '<p>x</p>',
        text: 'x',
        'recipient-variables': '{}',
      })
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a valid key used against a domain it does not own', async () => {
    shim.store.registerTenant('other-tenant.example.com', 'other-tenants-key');

    await expect(
      mailgunClient.messages.create('other-tenant.example.com', {
        to: ['member@example.com'],
        from: 'noreply@tenant1.example.com',
        subject: 'x',
        html: '<p>x</p>',
        text: 'x',
        'recipient-variables': '{}',
      })
    ).rejects.toMatchObject({ status: 401 });
  });

  it('a recipient listed twice in one send (well-formed — real Mailgun tolerates this) delivers exactly once and the shim stays up for the next request', async () => {
    // mailgun.js serialises each array entry as its own repeated multipart
    // field (see mailgunFields.ts's own docstring on this) — sending the
    // same address twice here exercises the real wire format the shim's
    // route parses, backed by a real sqlite queue with a
    // (batch_id, recipient) primary key, not the in-memory fake used by
    // the unit-level route tests.
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['dup@example.com', 'dup@example.com'],
      from: 'noreply@tenant1.example.com',
      subject: 'Duplicate recipient',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received).toHaveLength(1);

    // The process is still alive and serving requests — this is the
    // regression the test exists to catch: an unwrapped async handler
    // throwing on the duplicate's UNIQUE constraint violation used to
    // crash the whole process before this fix.
    const followUp = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['someone-else@example.com'],
      from: 'noreply@tenant1.example.com',
      subject: 'Still alive',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });
    expect(followUp.id).toBeTruthy();
    await sink.waitForCount(2);
  });
});
