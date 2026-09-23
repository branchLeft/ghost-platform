import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Interfaces } from 'mailgun.js';
import { createCollector, type Collector } from './helpers/collector.js';
import { createMailgunClient } from './helpers/mailgunClient.js';
import { startSmtpSink, type SmtpSink } from './helpers/smtpSink.js';
import { startTestShim, type TestShim } from './helpers/testServer.js';

// mailgun.js is the exact client library Ghost bundles
// (mailgun-client.js:367-370 constructs it the same way: `new
// Mailgun(formData)`, then `.client({username, key, url, timeout})`).
// Driving the shim through this library rather than hand-building
// multipart requests means the test exercises the real wire format, not a
// guess at it.
//
// The collector (test/helpers/collector.ts) plays the part LLD-6/#1239
// give to mx1 or ops1: it is the only caller that ever reaches GET /drain
// and POST /drain/ack, over the shim's real HTTP routes, delivering
// against a real SMTP listener (smtpSink.ts) standing in for the delivery
// host. Nothing here mocks the drain contract itself.

const TENANT_DOMAIN = 'tenant1.example.com';
const TENANT_API_KEY = 'test-tenant-1-api-key';
const SMTP_USER = 'collector-submission-user';
const SMTP_PASS = 'collector-submission-pass';

describe('mailgun-shaped shim — the drain handover, end to end', () => {
  let sink: SmtpSink;
  let shim: TestShim;
  let collector: Collector;
  let mailgunClient: Interfaces.IMailgunClient;

  beforeEach(async () => {
    sink = await startSmtpSink(SMTP_USER, SMTP_PASS);
    shim = await startTestShim();
    shim.store.registerTenant(TENANT_DOMAIN, TENANT_API_KEY);
    mailgunClient = createMailgunClient(shim.baseUrl, TENANT_API_KEY);
    collector = createCollector({
      shimBaseUrl: shim.baseUrl,
      drainToken: shim.drainToken,
      smtpPort: sink.port,
      smtpUser: SMTP_USER,
      smtpPass: SMTP_PASS,
    });
  });

  afterEach(async () => {
    collector.stop();
    await shim.close();
    await sink.close();
  });

  it('accepts a Ghost-shaped bulk send, and the collector drains it over SMTP with recipient batching and email-id correlation intact', async () => {
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

    // Nothing drains until the collector polls — the spool never dials out.
    await collector.drainOnce();

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

    // Acked — the queue is empty and the age gauge has gone quiet.
    expect(shim.store.countUndrainedRecipients()).toBe(0);
    expect(shim.store.oldestUndrainedAgeSeconds(Date.now() / 1000)).toBeNull();
  });

  it('a message enqueued while a GET /drain is already held open is handed over within the hold, not on the next poll', async () => {
    const drainPromise = fetch(`${shim.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${shim.drainToken}` },
    });

    // Give the held request time to actually be waiting before enqueueing.
    await new Promise((r) => setTimeout(r, 30));

    const start = Date.now();
    await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: 'noreply@tenant1.example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });

    const res = await drainPromise;
    const elapsedMs = Date.now() - start;
    const body = (await res.json()) as { messages: Array<{ id: string; to: string }> };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.to).toBe('member@example.com');
    // Woken by drainWake.notify(), not by waiting out the poll interval —
    // comfortably under the 200ms holdMs this test's shim is configured
    // with, let alone LLD-2's ~30s hold.
    expect(elapsedMs).toBeLessThan(150);
  });

  it('an unacknowledged message is re-offered under the same id once its lease lapses, and never duplicated while still held', async () => {
    await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['crash-before-ack@example.com'],
      from: 'noreply@tenant1.example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });

    const first = await fetch(`${shim.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${shim.drainToken}` },
    }).then((r) => r.json() as Promise<{ messages: Array<{ id: string }> }>);
    expect(first.messages).toHaveLength(1);
    const firstId = first.messages[0]!.id;

    // Simulates a collector that took the batch and crashed before acking —
    // no ack is ever sent for this id.

    // Still within the 5s test lease — not re-offered yet.
    const stillHeld = await fetch(`${shim.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${shim.drainToken}` },
    }).then((r) => r.json() as Promise<{ messages: unknown[] }>);
    expect(stillHeld.messages).toHaveLength(0);

    // Past the lease — re-offered under the same id.
    await new Promise((r) => setTimeout(r, 5200));
    const reoffered = await fetch(`${shim.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${shim.drainToken}` },
    }).then((r) => r.json() as Promise<{ messages: Array<{ id: string; drainCount: number }> }>);
    expect(reoffered.messages).toHaveLength(1);
    expect(reoffered.messages[0]!.id).toBe(firstId);
    expect(reoffered.messages[0]!.drainCount).toBe(2);
  }, 10_000);

  it('the producer-side oldest-undrained-age gauge rises while nothing drains and falls once the collector catches up', async () => {
    const before = await fetch(`${shim.baseUrl}/metrics`).then((r) => r.text());
    expect(before).toContain('mailgun_shim_oldest_undrained_age_seconds 0');

    await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: 'noreply@tenant1.example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });

    await new Promise((r) => setTimeout(r, 300));
    const whileQueued = await fetch(`${shim.baseUrl}/metrics`).then((r) => r.text());
    const match = /mailgun_shim_oldest_undrained_age_seconds (\d+(?:\.\d+)?)/.exec(whileQueued);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThan(0);
    expect(whileQueued).toContain('mailgun_shim_undrained_recipients 1');

    await collector.drainOnce();
    await sink.waitForCount(1);

    const afterDrain = await fetch(`${shim.baseUrl}/metrics`).then((r) => r.text());
    expect(afterDrain).toContain('mailgun_shim_oldest_undrained_age_seconds 0');
    expect(afterDrain).toContain('mailgun_shim_undrained_recipients 0');
  });

  it('GET /drain and POST /drain/ack both refuse a request with no valid bearer token, and never hand over mail to it', async () => {
    await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: 'noreply@tenant1.example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': '{}',
    });

    const noAuth = await fetch(`${shim.baseUrl}/drain`);
    expect(noAuth.status).toBe(401);

    const wrongToken = await fetch(`${shim.baseUrl}/drain`, {
      headers: { Authorization: 'Bearer not-the-real-token' },
    });
    expect(wrongToken.status).toBe(401);

    const ackWithoutAuth = await fetch(`${shim.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['whatever'] }),
    });
    expect(ackWithoutAuth.status).toBe(401);

    // Still fully queued — an unauthenticated caller took nothing.
    expect(shim.store.countUndrainedRecipients()).toBe(1);
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

  it('a suppressed recipient is resolved at drain time — never delivered, and un-suppressing re-enables it for the next send', async () => {
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

    await collector.drainOnce();
    // Give the (non-existent, for this recipient) delivery a moment to
    // (not) happen.
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.messages).toHaveLength(0);
    expect(shim.store.countUndrainedRecipients()).toBe(0); // resolved suppressed, not left pending

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

    await collector.drainOnce();
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

  it('a recipient listed twice in one send (well-formed — real Mailgun tolerates this) is drained exactly once and the shim stays up for the next request', async () => {
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

    await collector.drainOnce();
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
    await collector.drainOnce();
    await sink.waitForCount(2);
  });
});
