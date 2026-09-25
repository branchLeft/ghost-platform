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
    shim.store.registerTenant(TENANT_DOMAIN, TENANT_API_KEY, TENANT_DOMAIN);

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
    shim.store.registerTenant(
      'other-tenant.example.com',
      'other-tenants-key',
      'other-tenant.example.com'
    );

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

  it("refuses a From whose domain is not the authenticated tenant's, through the real HTTP route, and queues nothing", async () => {
    await expect(
      mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: 'Attacker <noreply@evil.example>',
        subject: 'Spoofed',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
      })
    ).rejects.toMatchObject({ status: 400 });

    await new Promise((r) => setTimeout(r, 200));
    expect(sink.messages).toHaveLength(0);
  });

  it("CONTROL: the tenant's own domain is accepted through the same real HTTP route", async () => {
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      subject: 'Legitimate',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.subject).toBe('Legitimate');
  });

  it('accepts an h:Reply-To naming a foreign domain, through the real HTTP route, and delivers it with that reply-to intact — it names where a reply goes, not who sent the mail', async () => {
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      'h:Reply-To': 'reply@evil.example',
      subject: 'Foreign reply-to',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.subject).toBe('Foreign reply-to');
  });

  // Sender is never taken from the tenant, on any spelling — dropped at
  // intake (mailgunFields.ts), never stored, never relayed. Every one of these is accepted (Ghost's own From is still
  // checked and still carries the send), and every one of them arrives
  // with NO Sender header at all — not the foreign value, not even a
  // matching one. Each case below is a distinct multipart field name
  // mailgun.js sends verbatim (verified separately against a raw HTTP
  // capture), so this proves the drop covers each field name individually,
  // not just the one nodemailer happens to normalise first.
  it('drops an h:Sender override naming a foreign domain, through the real HTTP route — the message still delivers with no Sender header', async () => {
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      'h:Sender': 'sender@evil.example',
      subject: 'Sender spoof',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.headers.get('sender')).toBeUndefined();
  });

  it('drops a duplicate h:Sender spelled with a different case even alongside a legitimate one, through the real HTTP route — no Sender line reaches the sink, on either key', async () => {
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      'h:Sender': `legit@${TENANT_DOMAIN}`,
      'h:sender': 'ceo@evil.example',
      subject: 'Sender spoof via a duplicate, differently-cased key',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.headers.get('sender')).toBeUndefined();
  });

  // A space is not a valid RFC 5322 field-name character at all (it's
  // outside 33-126), so a whitespace-padded key is caught by field-name
  // validation before the Sender drop ever gets to run on it — refused
  // with 400, same outward effect (no tenant Sender reaches the sink) via
  // the more general rule.
  it('refuses an h:Sender key padded with a trailing space, through the real HTTP route, with a 400, and queues nothing', async () => {
    await expect(
      mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: `Tenant <noreply@${TENANT_DOMAIN}>`,
        'h:Sender ': 'ceo@evil.example',
        subject: 'Sender spoof via a trailing-space key',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
      })
    ).rejects.toMatchObject({ status: 400 });

    await new Promise((r) => setTimeout(r, 200));
    expect(sink.messages).toHaveLength(0);
  });

  it('refuses an h:Sender key padded with a leading space, through the real HTTP route, with a 400, and queues nothing', async () => {
    await expect(
      mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: `Tenant <noreply@${TENANT_DOMAIN}>`,
        'h: Sender': 'ceo@evil.example',
        subject: 'Sender spoof via a leading-space key',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
      })
    ).rejects.toMatchObject({ status: 400 });

    await new Promise((r) => setTimeout(r, 200));
    expect(sink.messages).toHaveLength(0);
  });

  it('drops an h:Sender key spelled with mixed case, through the real HTTP route', async () => {
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      'h:SeNdEr': 'ceo@evil.example',
      subject: 'Sender spoof via a mixed-case key',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.headers.get('sender')).toBeUndefined();
  });

  it('refuses an h:Sender: key (a literal trailing colon) with a 400, through the real HTTP route, and queues nothing — nodemailer normalisation keeps the colon, so this cannot be caught by the Sender drop and must be caught by field-name validation instead', async () => {
    await expect(
      mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: `Tenant <noreply@${TENANT_DOMAIN}>`,
        'h:Sender:': 'ceo@evil.example',
        subject: 'Sender spoof via a trailing colon in the key',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
      })
    ).rejects.toMatchObject({ status: 400 });

    await new Promise((r) => setTimeout(r, 200));
    expect(sink.messages).toHaveLength(0);
  });

  it('refuses an h:*Sender key carrying an NBSP, a ZWSP, or a BOM, each with a 400, through the real HTTP route, and queues nothing', async () => {
    for (const [label, key] of [
      ['NBSP', 'h:\u00a0Sender'],
      ['ZWSP', 'h:\u200bSender'],
      ['BOM', 'h:Sender\ufeff'],
    ] as const) {
      await expect(
        mailgunClient.messages.create(TENANT_DOMAIN, {
          to: ['member@example.com'],
          from: `Tenant <noreply@${TENANT_DOMAIN}>`,
          [key]: 'ceo@evil.example',
          subject: `Sender spoof via ${label}`,
          html: '<p>hi</p>',
          text: 'hi',
          'recipient-variables': '{}',
        })
      ).rejects.toMatchObject({ status: 400 });
    }

    await new Promise((r) => setTimeout(r, 200));
    expect(sink.messages).toHaveLength(0);
  });

  it('refuses a tab or a control character inside an h:* field name with a 400, through the real HTTP route, and queues nothing', async () => {
    for (const key of ['h:Sen\tder', 'h:Sen\x01der']) {
      await expect(
        mailgunClient.messages.create(TENANT_DOMAIN, {
          to: ['member@example.com'],
          from: `Tenant <noreply@${TENANT_DOMAIN}>`,
          [key]: 'ceo@evil.example',
          subject: 'Sender spoof via a control character',
          html: '<p>hi</p>',
          text: 'hi',
          'recipient-variables': '{}',
        })
      ).rejects.toMatchObject({ status: 400 });
    }

    await new Promise((r) => setTimeout(r, 200));
    expect(sink.messages).toHaveLength(0);
  });

  // A %recipient.*% token in a Sender header, resolved by the worker AFTER
  // a per-request check, used to be able to reach the recipient with a
  // foreign address in either the local part or the display name — the
  // check approved the unresolved token string, and substitution then
  // turned it into something the check never saw. Dropping Sender
  // unconditionally at intake closes this by construction: the value
  // (token or not) is never stored, so it is never a candidate for
  // token resolution in the first place. Spelled `h:sender` (lower-case)
  // deliberately — this is the one spelling this shim's own worker does
  // NOT special-case for an already-queued legacy row (it only keeps
  // Ghost's own exact `Sender`), so these two tests are a genuine proof of
  // the intake drop specifically, not of the worker's narrower fallback.
  it('drops an h:sender carrying a %recipient.*% token in the local part, through the real HTTP route — no Sender header, resolved or not, reaches the sink', async () => {
    const recipientData = { 'member@example.com': { s: 'x@evil.com (' } };
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      'h:sender': `blog+%recipient.s%@${TENANT_DOMAIN}`,
      subject: 'Sender spoof via a recipient token in the local part',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': JSON.stringify(recipientData),
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.headers.get('sender')).toBeUndefined();
  });

  it('drops an h:sender carrying a %recipient.*% token in the display name, through the real HTTP route — no Sender header, resolved or not, reaches the sink', async () => {
    const recipientData = { 'member@example.com': { s: 'x" <ceo@evil.com>, "y' } };
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      'h:sender': `"%recipient.s%" <blog@${TENANT_DOMAIN}>`,
      subject: 'Sender spoof via a recipient token in the display name',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': JSON.stringify(recipientData),
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.headers.get('sender')).toBeUndefined();
  });

  it("CONTROL: Ghost's own h:Sender shape (one canonical key, matching the tenant's domain) is accepted and delivered, through the real HTTP route, with no Sender header on the wire at all", async () => {
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      'h:Sender': `noreply@${TENANT_DOMAIN}`,
      subject: "Ghost's own shape",
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.subject).toBe("Ghost's own shape");
    // Ghost's own h:Sender always equals its own From (mailgun-client.js:65,71,
    // forks/Ghost tag v6.55.0), so dropping it loses nothing — the message
    // still carries the checked From, just no separate Sender line.
    expect(received[0]!.parsed.headers.get('sender')).toBeUndefined();
    expect(received[0]!.parsed.from?.value[0]?.address).toBe(`noreply@${TENANT_DOMAIN}`);
  });

  // Proves, rather than assumes: an h:From cannot override the checked
  // `from` field, on any spelling of the key, because nodemailer's
  // mail-composer always applies the real `from` LAST via
  // setHeader, which replaces every custom header of the same normalised
  // name (mail-composer.js: "Add headers to the root node, always
  // overrides custom headers") — the request is accepted (h:From is never
  // itself checked, since it never reaches the wire), and delivered with
  // the real From intact, not the h:From value.
  it('an h:From override never reaches the wire, on any spelling of the key — the real From is what nodemailer sends', async () => {
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      'h:From': 'ceo@evil.example',
      'h:from': 'also-ceo@evil.example',
      'h:FROM': 'still-ceo@evil.example',
      subject: 'From override attempt',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.from?.value[0]?.address).toBe(`noreply@${TENANT_DOMAIN}`);
    // Only one From line reached the wire — nodemailer's setHeader
    // replaces the first match and removes the rest (mime-node/index.js),
    // it does not leave an extra, unchecked From line behind the way
    // addHeader would for a header setHeader never touches.
    const fromLines = received[0]!.parsed.headerLines.filter((l) => l.key === 'from');
    expect(fromLines).toHaveLength(1);
  });

  // `from` must never be %recipient.*%-substituted downstream, the way a
  // Sender header's value used to be able to be — because `from` is the
  // value the intake check already approved, and resolving a token in it
  // after that check would let an approved value turn into a different,
  // unchecked one on the wire. worker.ts's
  // `from: row.payload.from` deliberately bypasses resolveRecipientTokens
  // (unlike subject/html/text/headers); this proves that holds through the
  // real HTTP route and worker, not just by reading the source.
  it('never resolves a %recipient.*% token inside `from` — it reaches the wire literally, unsubstituted, even though it belongs to the tenant and passes the check', async () => {
    const recipientData = { 'member@example.com': { token: 'evil' } };
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <blog+%recipient.token%@${TENANT_DOMAIN}>`,
      subject: 'From token attempt',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': JSON.stringify(recipientData),
    });
    expect(response.id).toBeTruthy();

    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.from?.value[0]?.address).toBe(
      `blog+%recipient.token%@${TENANT_DOMAIN}`
    );
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
