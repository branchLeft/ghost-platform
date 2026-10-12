import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMessagesRouter } from '../../../src/routes/messages.js';
import { createDrainWake } from '../../../src/drainWake.js';
import { createTestLogger } from '../../helpers/testLogger.js';
import { createFakeStore, type FakeShimStore } from '../helpers/fakeStore.js';
import { basicAuthHeader, startRouter, type StartedRouter } from '../helpers/startRouter.js';
import { acceptedRows, refusedRows } from '../helpers/boundSenderRows.js';

const DOMAIN = 'tenant-a.example.com';
const API_KEY = 'tenant-a-api-key';

describe('POST /v3/:domain/messages queues the bound sender', () => {
  let store: FakeShimStore;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY, DOMAIN);
    server = await startRouter(
      createMessagesRouter(store, createDrainWake(), createTestLogger().logger)
    );
  });

  afterEach(async () => {
    await server.close();
  });

  function postFrom(from: string) {
    const form = new FormData();
    for (const [name, value] of [
      ['to', 'member@example.com'],
      ['from', from],
      ['subject', 'Hi'],
      ['html', '<p>hi</p>'],
      ['text', 'hi'],
      ['recipient-variables', '{}'],
    ] as const) {
      form.append(name, value);
    }
    return fetch(`${server.baseUrl}/v3/${DOMAIN}/messages`, {
      method: 'POST',
      headers: { Authorization: basicAuthHeader('api', API_KEY) },
      body: form,
    });
  }

  it.each(acceptedRows(DOMAIN).map((row) => [row.id, row] as const))(
    'queues the normal form for %s',
    async (_id, row) => {
      const res = await postFrom(row.submitted);
      expect(res.status).toBe(200);
      const claimed = store.claimForDrain(Date.now() / 1000, 30, 10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.payload.from).toBe(row.queued);
    }
  );

  it.each(refusedRows(DOMAIN).map((row) => [row.id, row] as const))(
    'refuses %s with 400, and queues nothing',
    async (_id, row) => {
      const res = await postFrom(row.submitted);
      expect(res.status).toBe(400);
      expect(store.claimForDrain(Date.now() / 1000, 30, 10)).toHaveLength(0);
    }
  );
});
