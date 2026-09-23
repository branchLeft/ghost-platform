import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessagesRouter } from '../../../src/routes/messages.js';
import { createDrainWake, type DrainWake } from '../../../src/drainWake.js';
import { createTestLogger, type TestLogger } from '../../helpers/testLogger.js';
import { createFakeStore, type FakeShimStore } from '../helpers/fakeStore.js';
import { basicAuthHeader, startRouter, type StartedRouter } from '../helpers/startRouter.js';

const DOMAIN = 'tenant1.example.com';
const API_KEY = 'tenant1-api-key';

function multipartBody(fields: Array<[string, string]>): FormData {
  const form = new FormData();
  for (const [name, value] of fields) {
    form.append(name, value);
  }
  return form;
}

/** Reads back the single row this test enqueued via claimForDrain — a real hand-over read, not a mock inspection. */
function claimOne(store: FakeShimStore) {
  return store.claimForDrain(Date.now() / 1000, 30, 10);
}

describe('POST /v3/:domain/messages', () => {
  let store: FakeShimStore;
  let wake: DrainWake;
  let testLogger: TestLogger;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY);
    wake = createDrainWake();
    testLogger = createTestLogger();
    server = await startRouter(createMessagesRouter(store, wake, testLogger.logger));
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

  it('enqueues durably and wakes the drain handover — nothing here dials out, it only queues', async () => {
    const notifySpy = vi.spyOn(wake, 'notify');

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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; message: string };
    expect(body.id).toBeTruthy();
    expect(body.message).toBe('Queued. Thank you.');

    expect(notifySpy).toHaveBeenCalledTimes(1);

    const claimed = claimOne(store);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.recipient).toBe('member@example.com');
    expect(claimed[0]!.domain).toBe(DOMAIN);
  });

  it('does not itself apply suppression or safety filtering — enqueues every recipient and leaves that to claim time', async () => {
    // Suppression/unsafe-address resolution moved to claimForDrain
    // (store.ts) so it happens once, at the one place a message actually
    // gets handed to a drainer, rather than being duplicated here.
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

    // Both recipients were queued — the suppressed one is resolved when
    // something actually claims the batch for drain, not here.
    const claimed = claimOne(store);
    expect(claimed.map((r) => r.recipient).sort()).toEqual(['ok@example.com']);
    // bounced@ resolved suppressed at claim (terminal); ok@ was claimed and
    // is now held, awaiting ack — still counts as undrained until then.
    expect(store.countUndrainedRecipients()).toBe(1);
  });

  it('batches personalised sends per recipient using recipient-variables, carried through in the queued payload', async () => {
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

    const claimed = claimOne(store);
    expect(claimed).toHaveLength(2);
    expect(claimed[0]!.payload.recipientVariables).toEqual(recipientData);
  });

  it('threads v:email-id through to the queued batch', async () => {
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

    const claimed = claimOne(store);
    expect(claimed[0]!.emailId).toBe('email-record-42');
  });

  it('rejects a request with no recipients, and never enqueues anything', async () => {
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
    expect(claimOne(store)).toHaveLength(0);
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

  it('401s without valid tenant credentials, and never enqueues anything', async () => {
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
    expect(claimOne(store)).toHaveLength(0);
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

    // One queued row, not two — and no crash from the (batch_id, recipient)
    // primary key that a duplicate row would otherwise violate.
    const claimed = claimOne(store);
    expect(claimed).toHaveLength(1);

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
    const claimed = claimOne(store);
    expect(claimed.map((r) => r.recipient).sort()).toEqual([
      'Member@example.com',
      'member@example.com',
    ]);
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
});
