import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMessagesRouter } from '../../../src/routes/messages.js';
import type { Transporter } from '../../../src/smtp.js';
import type { WorkerHandle } from '../../../src/worker.js';
import { createTestLogger, type TestLogger } from '../../helpers/testLogger.js';
import { createTestWorker } from '../../helpers/testWorker.js';
import { createFakeStore, type FakeShimStore } from '../helpers/fakeStore.js';
import { ghostStringify } from '../../helpers/ghostAddress.js';
import { basicAuthHeader, startRouter, type StartedRouter } from '../helpers/startRouter.js';
import { vi } from 'vitest';

const DOMAIN = 'tenant1.example.com';
const API_KEY = 'tenant1-api-key';

function multipartBody(fields: Array<[string, string]>): FormData {
  const form = new FormData();
  for (const [name, value] of fields) {
    form.append(name, value);
  }
  return form;
}

describe('POST /v3/:domain/messages', () => {
  let store: FakeShimStore;
  let sendMail: ReturnType<typeof vi.fn>;
  let transport: Transporter;
  let worker: WorkerHandle;
  let testLogger: TestLogger;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY, DOMAIN);
    sendMail = vi.fn(async () => ({}));
    transport = { sendMail } as unknown as Transporter;
    testLogger = createTestLogger();
    worker = createTestWorker(store, transport, { log: testLogger.logger });
    server = await startRouter(createMessagesRouter(store, worker, testLogger.logger));
  });

  afterEach(async () => {
    await worker.stop();
    await server.close();
  });

  function post(body: FormData | string, contentType?: string) {
    return fetch(`${server.baseUrl}/v3/${DOMAIN}/messages`, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader('api', API_KEY),
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body,
    });
  }

  it('excludes an already-suppressed recipient from delivery entirely', async () => {
    store.addSuppression(DOMAIN, 'bounces', 'bounced@example.com');

    const res = await post(
      multipartBody([
        ['to', 'bounced@example.com'],
        ['to', 'ok@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();

    expect(sendMail).toHaveBeenCalledTimes(1);
    const sentTo = sendMail.mock.calls[0]![0].to;
    expect(sentTo).toBe('ok@example.com');

    // No event at all for the suppressed recipient — not even a "failed" one.
    expect(store.events.some((e) => e.recipient === 'bounced@example.com')).toBe(false);
    expect(
      store.events.some((e) => e.recipient === 'ok@example.com' && e.type === 'delivered')
    ).toBe(true);
  });

  it('checks all three suppression types for each recipient, not just one', async () => {
    store.addSuppression(DOMAIN, 'complaints', 'complained@example.com');
    store.addSuppression(DOMAIN, 'unsubscribes', 'unsubscribed@example.com');

    const res = await post(
      multipartBody([
        ['to', 'complained@example.com'],
        ['to', 'unsubscribed@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('batches personalised sends per recipient using recipient-variables', async () => {
    const recipientData = {
      'member-a@example.com': { name: 'Member A' },
      'member-b@example.com': { name: 'Member B' },
    };
    const res = await post(
      multipartBody([
        ['to', 'member-a@example.com'],
        ['to', 'member-b@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hello %recipient.name%'],
        ['html', '<p>Hi %recipient.name%</p>'],
        ['text', 'Hi %recipient.name%'],
        ['recipient-variables', JSON.stringify(recipientData)],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();

    expect(sendMail).toHaveBeenCalledTimes(2);
    const byRecipient = new Map(
      sendMail.mock.calls.map((call) => [call[0].to.address ?? call[0].to, call[0]])
    );
    expect(byRecipient.get('member-a@example.com')?.subject).toBe('Hello Member A');
    expect(byRecipient.get('member-b@example.com')?.subject).toBe('Hello Member B');
  });

  it('threads v:email-id through to the recorded delivery event', async () => {
    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
        ['v:email-id', 'email-record-42'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();

    const event = store.events.find((e) => e.recipient === 'member@example.com');
    expect(event?.emailId).toBe('email-record-42');
  });

  it('rejects a request with no recipients', async () => {
    const res = await post(
      multipartBody([
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('No recipients');
    await worker.whenIdle();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('rejects a malformed body (unparseable multipart) with 400 rather than crashing', async () => {
    const res = await post(
      'not-a-multipart-body',
      'multipart/form-data; boundary=not-the-real-boundary'
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('Failed to parse request');
  });

  it('rejects a body sent with a content type busboy cannot handle at all', async () => {
    const res = await post(JSON.stringify({ to: 'member@example.com' }), 'application/json');
    expect(res.status).toBe(400);
  });

  it('a downstream failure while the worker is sending is logged, not thrown into the request handler', async () => {
    const recordSentSpy = vi.spyOn(store, 'recordRecipientSent').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    // The response already went out before the worker processed the row —
    // a downstream failure there must not turn into a 500 here.
    expect(res.status).toBe(200);

    await worker.whenIdle();
    expect(
      testLogger.lines.some(
        (line) => line.event === 'worker_lifecycle' && line.fields.event === 'tick_failed'
      )
    ).toBe(true);

    recordSentSpy.mockRestore();
  });

  it("refuses a 'from' address whose domain is not the authenticated tenant's, and queues nothing", async () => {
    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', 'Attacker <noreply@evil.example>'],
        ['subject', 'Spoofed'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(400);
    await worker.whenIdle();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("CONTROL: a 'from' address at the tenant's own domain is accepted", async () => {
    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', `Tenant <noreply@${DOMAIN}>`],
        ['subject', 'Legitimate'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('accepts an h:Reply-To naming a foreign domain — it names where a reply goes, not who sent the mail, and Ghost lets admins set any newsletter reply-to', async () => {
    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', `noreply@${DOMAIN}`],
        ['h:Reply-To', 'reply@evil.example'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('drops an h:Sender override naming a foreign domain rather than refusing the request — it never reaches nodemailer', async () => {
    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', `noreply@${DOMAIN}`],
        ['h:Sender', 'sender@evil.example'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(1);
    const headersSent = sendMail.mock.calls[0]![0].headers as Record<string, string>;
    expect(Object.keys(headersSent)).toEqual([]);
  });

  it('drops an h:Sender override spelled with different casing — the drop is keyed on nodemailer normalisation, not a literal match', async () => {
    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', `noreply@${DOMAIN}`],
        ['h:sender', 'sender@evil.example'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(1);
    const headersSent = sendMail.mock.calls[0]![0].headers as Record<string, string>;
    expect(Object.keys(headersSent)).toEqual([]);
  });

  it("CONTROL: an h:Reply-To/h:Sender at the tenant's own domain is accepted, Reply-To reaches the wire and Sender is dropped regardless", async () => {
    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', `noreply@${DOMAIN}`],
        ['h:Reply-To', `support@${DOMAIN}`],
        ['h:Sender', `noreply@${DOMAIN}`],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]![0].replyTo).toBe(`support@${DOMAIN}`);
    const headersSent = sendMail.mock.calls[0]![0].headers as Record<string, string>;
    expect(Object.keys(headersSent)).toEqual([]);
  });

  it('refuses an h:* field name that is not a valid RFC 5322 field name, with a 400, and queues nothing', async () => {
    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', `noreply@${DOMAIN}`],
        ['h:Sender:', 'ceo@evil.example'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(400);
    await worker.whenIdle();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('401s without valid tenant credentials, and never attempts delivery', async () => {
    const res = await fetch(`${server.baseUrl}/v3/${DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader('api', 'wrong-key') },
      body: multipartBody([
        ['to', 'member@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ]),
    });
    expect(res.status).toBe(401);
    await worker.whenIdle();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('deduplicates a recipient listed twice in the same send to one queued row, and the server keeps serving requests afterwards', async () => {
    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['to', 'member@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();

    // One send, not two — and no crash from the (batch_id, recipient)
    // primary key that a duplicate row would otherwise violate.
    expect(sendMail).toHaveBeenCalledTimes(1);

    // The server is still alive and answering further requests — this is
    // the regression this test exists to catch: an unhandled rejection
    // from the duplicate would have crashed the whole process.
    const followUp = await post(
      multipartBody([
        ['to', 'someone-else@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Still alive'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(followUp.status).toBe(200);
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('treats differently-cased local parts as distinct recipients — dedup is exact-string, not case-insensitive', async () => {
    const res = await post(
      multipartBody([
        ['to', 'Member@example.com'],
        ['to', 'member@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(200);
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('a store throw during enqueue yields a 500 JSON response, not a crash — and the server keeps serving requests afterwards', async () => {
    const enqueueSpy = vi.spyOn(store, 'enqueueBatch').mockImplementation(() => {
      throw new Error('disk full');
    });

    const res = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBeTruthy();
    expect(
      testLogger.lines.some(
        (line) => line.event === 'request_failed' && line.fields.error === 'disk full'
      )
    ).toBe(true);

    enqueueSpy.mockRestore();

    const followUp = await post(
      multipartBody([
        ['to', 'member@example.com'],
        ['from', 'noreply@tenant1.example.com'],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ])
    );
    expect(followUp.status).toBe(200);
  });

  it('fails closed with a 500 when the authenticated tenant has no registered sender domain (e.g. a pre-migration row), rather than falling back to the credential key', async () => {
    const legacyDomain = 'legacy-tenant.example.com';
    const legacyKey = 'legacy-tenant-api-key';
    store.registerTenant(legacyDomain, legacyKey, null);

    const res = await fetch(`${server.baseUrl}/v3/${legacyDomain}/messages`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader('api', legacyKey) },
      body: multipartBody([
        ['to', 'member@example.com'],
        ['from', `noreply@${legacyDomain}`],
        ['subject', 'Hi'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ]),
    });

    expect(res.status).toBe(500);
    await worker.whenIdle();
    expect(sendMail).not.toHaveBeenCalled();
    expect(
      testLogger.lines.some(
        (line) =>
          line.event === 'sender_domain_not_registered' &&
          line.fields.domain === legacyDomain &&
          line.fields.route === 'http'
      )
    ).toBe(true);
  });

  it("accepts exactly Ghost's real newsletter field set for tenant zero — the LIVE credential key (blog.branchleft.co.uk) registered with its real sender domain (branchleft.co.uk), from/h:Sender/h:Reply-To built the way EmailAddressParser.stringify actually builds them", async () => {
    // The credential key is NOT the sending domain for the only live
    // tenant. mailgun-client.js posts `from` and `h:Sender` as the same
    // address, and (with sender_reply_to=newsletter) `h:Reply-To` as the
    // newsletter's own reply-to, which for tenant zero is the same apex
    // address — all three built by EmailAddressParser.stringify
    // (email-address-parser.js, forks/Ghost tag v6.55.0), which ALWAYS
    // double-quotes a present name (`"${name}" <${address}>`, backslash
    // and `"` escaped first), never emits it bare — an unquoted name here
    // would prove nothing about the real wire shape. ghostFrom below is
    // that exact function, not a hand-typed guess at its output.
    const senderKey = 'blog-tenant-zero-key';
    store.registerTenant('blog.branchleft.co.uk', senderKey, 'branchleft.co.uk');
    const ghostFrom = ghostStringify('branchLeft blog', 'blog@branchleft.co.uk');

    const res = await fetch(`${server.baseUrl}/v3/blog.branchleft.co.uk/messages`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader('api', senderKey) },
      body: multipartBody([
        ['to', 'member@example.com'],
        ['from', ghostFrom],
        ['h:Sender', ghostFrom],
        ['h:Reply-To', ghostFrom],
        ['subject', 'Your sign-in link'],
        ['html', '<p>hi</p>'],
        ['text', 'hi'],
        ['recipient-variables', '{}'],
      ]),
    });

    expect(res.status).toBe(200);
    await worker.whenIdle();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
