import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Interfaces } from 'mailgun.js';
import nodemailer from 'nodemailer';
import { createCollector, type Collector, type DrainedWireMessage } from './helpers/collector.js';
import { createMailgunClient } from './helpers/mailgunClient.js';
import { startSmtpSink, type SmtpSink } from './helpers/smtpSink.js';
import { startTestShim, type TestShim } from './helpers/testServer.js';
import { createThrottle } from '../src/throttle.js';

/**
 * Reads `GET /drain` directly, the same real route the production collector
 * will eventually poll, but without also routing the result through
 * nodemailer's own rendering (`collector.ts`'s `drainOnce`) — a collector
 * that renders via nodemailer happens to mask a raw `headers.From` (or a
 * CRLF-carrying value) surviving into the wire payload, because
 * nodemailer's own `setHeader` overrides a custom `From` and folds a bare
 * CRLF when it later builds the outgoing message. Proving the drain
 * payload itself is clean — independent of whatever eventually consumes it
 * — is the point of the tests that use this helper. Never acks, so it
 * never competes with `collector` for the same row within one test.
 */
async function rawDrainOnce(shim: TestShim): Promise<{ messages: DrainedWireMessage[] }> {
  const res = await fetch(`${shim.baseUrl}/drain`, {
    headers: { Authorization: `Bearer ${shim.drainToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET /drain failed: ${res.status}`);
  }
  return (await res.json()) as { messages: DrainedWireMessage[] };
}

// mailgun.js is the exact client library Ghost bundles
// (mailgun-client.js:367-370 constructs it the same way: `new
// Mailgun(formData)`, then `.client({username, key, url, timeout})`).
// Driving the shim through this library rather than hand-building
// multipart requests means the test exercises the real wire format, not a
// guess at it.
//
// The collector (test/helpers/collector.ts) plays the part LLD-6 gives to
// mx1 or ops1: it is the only caller that ever reaches GET /drain
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
    shim.store.registerTenant(TENANT_DOMAIN, TENANT_API_KEY, TENANT_DOMAIN);
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
      'v:email-id': '64f1a2b3c4d5e6f7a8b9c0d1',
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
    expect(toA!.parsed.headers.get('x-ghost-email-id')).toBe('64f1a2b3c4d5e6f7a8b9c0d1');

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

  it('the first message ever sent, at the PRODUCTION throttle default (50/hour, no override), is still handed over within a second — the cold-start grace token, not the test-only boosted rate', async () => {
    // A second, independent shim: the outer describe's `shim` uses the
    // unlimited test throttle everywhere else in this file. This one uses
    // createThrottle with no envMessagesPerHour override at all, so it
    // resolves to the exact same 50/hour a real deploy gets — proving the
    // Done sentence ("handed over ... within a second of enqueue") holds
    // against what actually ships, not only against a compressed test
    // rate. Before the grace-token fix, this was ~72 seconds off, not a
    // typo — 1/50 of an hour, for the very first message a fresh spool
    // ever queues.
    const prodShim = await startTestShim({
      throttle: createThrottle({ envMessagesPerHour: 0 }), // 0 -> createThrottle's own 50/hour default
    });
    prodShim.store.registerTenant(TENANT_DOMAIN, TENANT_API_KEY, TENANT_DOMAIN);
    const prodClient = createMailgunClient(prodShim.baseUrl, TENANT_API_KEY);
    try {
      await prodClient.messages.create(TENANT_DOMAIN, {
        to: ['first-ever@example.com'],
        from: 'noreply@tenant1.example.com',
        subject: 'Hi',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
      });

      const start = Date.now();
      const res = await fetch(`${prodShim.baseUrl}/drain`, {
        headers: { Authorization: `Bearer ${prodShim.drainToken}` },
      });
      const elapsedMs = Date.now() - start;
      const body = (await res.json()) as { messages: Array<{ to: string }> };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]!.to).toBe('first-ever@example.com');
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await prodShim.close();
    }
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
      body: JSON.stringify({ acks: [{ id: 'whatever', drainCount: 1 }] }),
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

    await collector.drainOnce();
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

    await collector.drainOnce();
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

    await collector.drainOnce();
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

    await collector.drainOnce();
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

    await collector.drainOnce();
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

  // A %recipient.*% token in a Sender header, resolved AFTER a per-request
  // check, used to be able to reach the recipient with a foreign address in
  // either the local part or the display name — the check approved the
  // unresolved token string, and substitution then turned it into something
  // the check never saw (token resolution happens in routes/drain.ts's
  // toWireMessage now, the direct successor of the deleted worker.ts's
  // processRow). Dropping Sender unconditionally at intake closes this by
  // construction: the value (token or not) is never stored, so it is never
  // a candidate for token resolution in the first place. Spelled
  // `h:sender` (lower-case) deliberately — this is the one spelling
  // toWireMessage does NOT special-case for an already-queued legacy row
  // (it only keeps Ghost's own exact `Sender`), so these two tests are a
  // genuine proof of the intake drop specifically, not of that narrower
  // fallback.
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

    await collector.drainOnce();
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

    await collector.drainOnce();
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

    await collector.drainOnce();
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

    await collector.drainOnce();
    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.from?.value[0]?.address).toBe(`noreply@${TENANT_DOMAIN}`);
    // Only one From line reached the wire — nodemailer's setHeader
    // replaces the first match and removes the rest (mime-node/index.js),
    // it does not leave an extra, unchecked From line behind the way
    // addHeader would for a header setHeader never touches.
    const fromLines = received[0]!.parsed.headerLines.filter((l) => l.key === 'from');
    expect(fromLines).toHaveLength(1);
  });

  // Review cycle 6: intake (mailgunFields.ts) now drops every h:* key that
  // normalises to 'From' too, the same way it already drops 'Sender' —
  // proven here directly against the raw GET /drain payload (rawDrainOnce,
  // above), not through the collector's nodemailer rendering, which the
  // previous "an h:From override never reaches the wire" test used and
  // which review found proved nothing about what the drain payload itself
  // carries: nodemailer's own setHeader happens to override a custom From
  // regardless of whether intake ever stored one.
  it('drops every h:* key that normalises to From, on every spelling, through the real HTTP route and the real GET /drain payload', async () => {
    for (const key of ['h:From', 'h:from', 'h:FROM']) {
      const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: `Tenant <noreply@${TENANT_DOMAIN}>`,
        [key]: 'ceo@evil.example',
        subject: `From override via ${key}`,
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
      });
      expect(response.id).toBeTruthy();

      const drained = await rawDrainOnce(shim);
      const message = drained.messages.find((m) => m.subject === `From override via ${key}`);
      expect(message).toBeDefined();
      expect(Object.keys(message!.headers).some((h) => h.toLowerCase() === 'from')).toBe(false);
      expect(message!.from).toBe(`Tenant <noreply@${TENANT_DOMAIN}>`);
    }
  });

  it('drops an h:From carrying a %recipient.*% token, through the real HTTP route and the real GET /drain payload — resolved or not, no From header reaches it', async () => {
    const recipientData = { 'member@example.com': { x: 'ceo@evil.example' } };
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      'h:From': '%recipient.x%',
      subject: 'From override via a recipient token',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': JSON.stringify(recipientData),
    });
    expect(response.id).toBeTruthy();

    const drained = await rawDrainOnce(shim);
    const message = drained.messages.find(
      (m) => m.subject === 'From override via a recipient token'
    );
    expect(message).toBeDefined();
    expect(Object.keys(message!.headers).some((h) => h.toLowerCase() === 'from')).toBe(false);
    expect(message!.from).toBe(`Tenant <noreply@${TENANT_DOMAIN}>`);
  });

  // Review cycle 6: CR, LF and NUL are refused at intake in every
  // header-bound field — from, every h:* value, subject and every
  // recipient-variables value — because any of them can inject a second
  // header line (or truncate one) once the drain payload eventually
  // reaches a real header-based renderer (#1239's collector, not built
  // yet). html/text are deliberately exempt: Ghost's own bodies legitimately
  // carry newlines, and this rule only applies to header-bound fields — see
  // the CONTROL test below.
  it("refuses a 'from' whose display name carries a CRLF header-injection attempt, with a 400, through the real HTTP route, and queues nothing", async () => {
    await expect(
      mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: `"x\r\nSender: ceo@evil.com" <blog@${TENANT_DOMAIN}>`,
        subject: 'CRLF in from',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
      })
    ).rejects.toMatchObject({ status: 400 });

    const drained = await rawDrainOnce(shim);
    expect(drained.messages).toHaveLength(0);
  });

  it('refuses a CRLF-injecting h:* value with a 400, through the real HTTP route, and queues nothing', async () => {
    await expect(
      mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: `Tenant <noreply@${TENANT_DOMAIN}>`,
        'h:X-Foo': 'a\r\nSender: ceo@evil.com',
        subject: 'CRLF in an h:* value',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
      })
    ).rejects.toMatchObject({ status: 400 });

    const drained = await rawDrainOnce(shim);
    expect(drained.messages).toHaveLength(0);
  });

  it('refuses a CRLF-injecting subject with a 400, through the real HTTP route, and queues nothing', async () => {
    await expect(
      mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: `Tenant <noreply@${TENANT_DOMAIN}>`,
        subject: 'a\r\nSender: ceo@evil.com',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
      })
    ).rejects.toMatchObject({ status: 400 });

    const drained = await rawDrainOnce(shim);
    expect(drained.messages).toHaveLength(0);
  });

  // Review cycle 7: unlike from/h:*/subject (tenant-authored, refused
  // outright above), a recipient-variables value is member-supplied — a
  // signup name Ghost does not sanitise — so a CR/LF/NUL there is replaced
  // with a space rather than refusing the whole batch. Refusing would let
  // one member's uncontrolled name fail delivery to every other recipient
  // in the same Ghost newsletter send.
  it("replaces a CR, LF or NUL in a member's recipient-variables value with a space rather than failing the whole batch, through the real HTTP route and the real GET /drain payload", async () => {
    const recipientData = {
      'member@example.com': { name: 'Ann\r\nSender: ceo@evil.com' },
    };
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      subject: 'Hello %recipient.name%',
      html: '<p>Hi %recipient.name%</p>',
      text: 'Hi %recipient.name%',
      'recipient-variables': JSON.stringify(recipientData),
    });
    expect(response.id).toBeTruthy();

    const drained = await rawDrainOnce(shim);
    const message = drained.messages.find((m) => m.to === 'member@example.com');
    expect(message).toBeDefined();
    // The %recipient.name% substitution (routes/drain.ts's toWireMessage)
    // is what would splice an unsanitised member name into a header-bound
    // field — this proves the value it substitutes is already clean.
    expect(message!.subject).not.toMatch(/[\r\n\0]/);
    expect(message!.html).not.toMatch(/[\r\n\0]/);
    expect(message!.subject).toBe('Hello Ann  Sender: ceo@evil.com');
  });

  it('replaces a CR, LF or NUL nested inside an object in a recipient-variables value, not just a top-level one, through the real HTTP route and the real GET /drain payload', async () => {
    const recipientData = {
      'member@example.com': { nested: { x: 'a\r\nSender: ceo@evil.com' } },
    };
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      subject: 'CRLF nested in recipient-variables',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': JSON.stringify(recipientData),
    });
    expect(response.id).toBeTruthy();

    const drained = await rawDrainOnce(shim);
    const message = drained.messages.find(
      (m) => m.subject === 'CRLF nested in recipient-variables'
    );
    expect(message).toBeDefined();
  });

  // Review cycle 6's blocking finding 1: v:email-id is tenant-authored
  // (Ghost's own request sets it, never a member), so — unlike
  // recipient-variables — it is refused outright, the same as from/h:*/
  // subject, not sanitised. It reaches headers['X-Ghost-Email-Id']
  // unresolved (routes/drain.ts's toWireMessage), so a CRLF there was an
  // injected header line on GET /drain's own payload before this fix.
  it('refuses a v:email-id carrying a CRLF-injected Sender line with a 400, through the real HTTP route, and queues nothing — measured on the real GET /drain payload', async () => {
    await expect(
      mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: `Tenant <noreply@${TENANT_DOMAIN}>`,
        subject: 'v:email-id CRLF',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
        'v:email-id': 'a\r\nSender: ceo@evil.com',
      })
    ).rejects.toMatchObject({ status: 400 });

    const drained = await rawDrainOnce(shim);
    expect(drained.messages).toHaveLength(0);
  });

  it('refuses a v:email-id that is not a real Ghost object id shape, with a 400, and queues nothing', async () => {
    await expect(
      mailgunClient.messages.create(TENANT_DOMAIN, {
        to: ['member@example.com'],
        from: `Tenant <noreply@${TENANT_DOMAIN}>`,
        subject: 'v:email-id not an object id',
        html: '<p>hi</p>',
        text: 'hi',
        'recipient-variables': '{}',
        'v:email-id': 'not-an-object-id',
      })
    ).rejects.toMatchObject({ status: 400 });

    const drained = await rawDrainOnce(shim);
    expect(drained.messages).toHaveLength(0);
  });

  it("CONTROL: Ghost's real newsletter — a multi-line html/text body — still gives 200; the CR/LF/NUL rule never applies to html or text", async () => {
    const response = await mailgunClient.messages.create(TENANT_DOMAIN, {
      to: ['member@example.com'],
      from: `Tenant <noreply@${TENANT_DOMAIN}>`,
      subject: 'Weekly digest',
      html: '<p>Paragraph one.</p>\r\n<p>Paragraph two.</p>\n<p>Paragraph three.</p>',
      text: 'Paragraph one.\r\nParagraph two.\nParagraph three.',
      'recipient-variables': '{}',
    });
    expect(response.id).toBeTruthy();

    const drained = await rawDrainOnce(shim);
    const message = drained.messages.find((m) => m.subject === 'Weekly digest');
    expect(message).toBeDefined();
    expect(message!.html).toContain('\r\n');
    expect(message!.text).toContain('\n');
  });

  // `from` must never be %recipient.*%-substituted downstream, the way a
  // Sender header's value used to be able to be — because `from` is the
  // value the intake check already approved, and resolving a token in it
  // after that check would let an approved value turn into a different,
  // unchecked one on the wire. routes/drain.ts's toWireMessage builds
  // `from: row.payload.from` deliberately outside the resolveRecipientTokens
  // calls it makes for subject/html/text/headers; this proves that holds
  // through the real HTTP route and the real drain handover, not just by
  // reading the source.
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

    await collector.drainOnce();
    const received = await sink.waitForCount(1);
    expect(received[0]!.parsed.from?.value[0]?.address).toBe(
      `blog+%recipient.token%@${TENANT_DOMAIN}`
    );
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

describe('the SMTP front door and the HTTP Mailgun-shaped route are one queue, not two', () => {
  // One shim instance with BOTH front doors listening, sharing the same
  // store and wake (exactly server.ts's own wiring) — proves a message
  // enqueued through the SMTP side is drainable, ackable and never
  // re-offered exactly like one enqueued through the HTTP side, not
  // merely that each front door individually reaches the store.
  let shim: TestShim;

  beforeEach(async () => {
    shim = await startTestShim({ startSmtpFrontDoor: true });
    shim.store.registerTenant(TENANT_DOMAIN, TENANT_API_KEY, TENANT_DOMAIN);
  });

  afterEach(async () => {
    await shim.close();
  });

  async function sendOverSmtp(): Promise<void> {
    const transport = nodemailer.createTransport({
      host: '127.0.0.1',
      port: shim.smtpPort,
      secure: false,
      ignoreTLS: true,
      auth: { user: TENANT_DOMAIN, pass: TENANT_API_KEY },
    });
    try {
      await transport.sendMail({
        from: `noreply@${TENANT_DOMAIN}`,
        to: 'member@example.com',
        subject: 'Sign-in link',
        text: 'Click here to sign in',
      });
    } finally {
      transport.close();
    }
  }

  it('a message enqueued over SMTP appears on GET /drain, is acked, and is never re-offered', async () => {
    await sendOverSmtp();

    const drainRes = await fetch(`${shim.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${shim.drainToken}` },
    });
    expect(drainRes.status).toBe(200);
    const drainBody = (await drainRes.json()) as {
      messages: Array<{ id: string; to: string; drainCount: number }>;
    };
    expect(drainBody.messages).toHaveLength(1);
    expect(drainBody.messages[0]!.to).toBe('member@example.com');
    const { id, drainCount } = drainBody.messages[0]!;

    // Still outstanding — held, not yet acked.
    expect(shim.store.countUndrainedRecipients()).toBe(1);

    const ackRes = await fetch(`${shim.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.drainToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ acks: [{ id, drainCount }] }),
    });
    expect(ackRes.status).toBe(200);
    const ackBody = (await ackRes.json()) as {
      acked: string[];
      alreadyHandled: string[];
      unknown: string[];
    };
    expect(ackBody.acked).toEqual([id]);

    // Gone for good — the same store, drained and acked through the same
    // handover an HTTP-enqueued message would go through.
    expect(shim.store.countUndrainedRecipients()).toBe(0);

    // Never re-offered: a fresh drain call, immediately, comes back empty
    // rather than handing the same id out again.
    const secondDrainRes = await fetch(`${shim.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${shim.drainToken}` },
    });
    const secondDrainBody = (await secondDrainRes.json()) as { messages: unknown[] };
    expect(secondDrainBody.messages).toEqual([]);
  });

  it('a message enqueued over SMTP wakes an already-held GET /drain, the same as one enqueued over HTTP', async () => {
    // A generous holdMs, not the outer describe's 200ms default: an SMTP
    // submission is several protocol round trips plus AUTH's own async
    // scrypt check, not the single HTTP request the equivalent HTTP-side
    // test sends — comfortably fast locally, but with far less headroom
    // against a loaded CI runner than one HTTP POST has. pollIntervalMs is
    // raised to at least holdMs too: with the default 20ms poll, the held
    // request would pick the message up on its next poll regardless of
    // whether notify() ever fired, and the sabotage below would stay green.
    // Only notify() can end this hold before it lapses. What this test
    // proves is that the wait ends on notify(), not on the hold timing out.
    const holdMs = 5000;
    const wakeShim = await startTestShim({
      startSmtpFrontDoor: true,
      drainOptions: { holdMs, pollIntervalMs: holdMs * 2 },
    });
    wakeShim.store.registerTenant(TENANT_DOMAIN, TENANT_API_KEY, TENANT_DOMAIN);
    try {
      const drainPromise = fetch(`${wakeShim.baseUrl}/drain`, {
        headers: { Authorization: `Bearer ${wakeShim.drainToken}` },
      });
      await new Promise((r) => setTimeout(r, 30));

      const transport = nodemailer.createTransport({
        host: '127.0.0.1',
        port: wakeShim.smtpPort,
        secure: false,
        ignoreTLS: true,
        auth: { user: TENANT_DOMAIN, pass: TENANT_API_KEY },
      });
      try {
        await transport.sendMail({
          from: `noreply@${TENANT_DOMAIN}`,
          to: 'member@example.com',
          subject: 'Sign-in link',
          text: 'Click here to sign in',
        });
      } finally {
        transport.close();
      }

      // Timed from the front door's own record of when the message became
      // real (enqueueBatch, just before wake.notify() — see
      // smtpFrontDoor.ts), not from when this client started the SMTP
      // submission: the submission itself (AUTH's scrypt check, MAIL/RCPT/
      // DATA) is several times the bound below, so timing from its start
      // would pass on protocol overhead alone rather than on the wake.
      const enqueueLine = wakeShim.smtpLogLines?.find((line) => line.event === 'smtp_enqueue');
      if (!enqueueLine) {
        throw new Error('smtp_enqueue was never logged by the front door');
      }
      const enqueueTime = new Date(enqueueLine.ts).getTime();

      const res = await drainPromise;
      const elapsedMs = Date.now() - enqueueTime;
      const body = (await res.json()) as { messages: Array<{ to: string }> };

      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]!.to).toBe('member@example.com');
      // Woken by the SAME drainWake instance the HTTP route's own enqueue
      // wakes — under a second from enqueue, matching the Done sentence.
      // With pollIntervalMs raised above holdMs, a stalled notify() has no
      // poll to fall back on: the hold would run out at ~holdMs (5000ms)
      // after the request began, not within this bound.
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      await wakeShim.close();
    }
  });
});
