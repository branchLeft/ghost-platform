import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessagesRouter } from '../../../src/routes/messages.js';
import type { Transporter } from '../../../src/smtp.js';
import { createFakeStore, type FakeShimStore } from '../helpers/fakeStore.js';
import { basicAuthHeader, startRouter, wait, type StartedRouter } from '../helpers/startRouter.js';

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
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY);
    sendMail = vi.fn(async () => ({}));
    transport = { sendMail } as unknown as Transporter;
    server = await startRouter(createMessagesRouter(store, transport));
  });

  afterEach(async () => {
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

    await wait(100);

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
    await wait(100);
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
    await wait(100);

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
    await wait(100);

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
    await wait(20);
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

  it('a downstream failure in the fire-and-forget delivery path is logged, not thrown into the request handler', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recordEventSpy = vi.spyOn(store, 'recordEvent').mockImplementation(() => {
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
    // The response already went out before the async delivery path ran —
    // a downstream failure in that path must not turn into a 500 here.
    expect(res.status).toBe(200);

    await wait(50);
    expect(errorSpy).toHaveBeenCalledWith('mailgun-shim: async delivery failed', expect.any(Error));

    recordEventSpy.mockRestore();
    errorSpy.mockRestore();
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
    await wait(20);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
