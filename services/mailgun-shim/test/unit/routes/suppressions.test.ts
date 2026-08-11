import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSuppressionsRouter } from '../../../src/routes/suppressions.js';
import { createFakeStore, type FakeShimStore } from '../helpers/fakeStore.js';
import { basicAuthHeader, startRouter, type StartedRouter } from '../helpers/startRouter.js';

const DOMAIN = 'tenant1.example.com';
const API_KEY = 'tenant1-api-key';

describe('DELETE /v3/:domain/:type/:email', () => {
  let store: FakeShimStore;
  let server: StartedRouter;

  beforeEach(async () => {
    store = createFakeStore();
    store.registerTenant(DOMAIN, API_KEY);
    server = await startRouter(createSuppressionsRouter(store));
  });

  afterEach(async () => {
    await server.close();
  });

  function del(path: string) {
    return fetch(`${server.baseUrl}${path}`, {
      method: 'DELETE',
      headers: { Authorization: basicAuthHeader('api', API_KEY) },
    });
  }

  it.each(['bounces', 'complaints', 'unsubscribes'] as const)(
    'removes a %s suppression and re-enables sending',
    async (type) => {
      store.addSuppression(DOMAIN, type, 'member@example.com');
      const res = await del(`/v3/${DOMAIN}/${type}/${encodeURIComponent('member@example.com')}`);
      expect(res.status).toBe(200);
      expect(store.isSuppressed(DOMAIN, type, 'member@example.com')).toBe(false);
    }
  );

  it('an unrecognised suppression type does not match this route at all (404, not a 500 or a silent no-op)', async () => {
    const res = await del(
      `/v3/${DOMAIN}/not-a-real-type/${encodeURIComponent('member@example.com')}`
    );
    expect(res.status).toBe(404);
  });

  it('removing a suppression for an unknown email still returns 200 (idempotent, matches Mailgun)', async () => {
    const res = await del(
      `/v3/${DOMAIN}/bounces/${encodeURIComponent('never-suppressed@example.com')}`
    );
    expect(res.status).toBe(200);
  });

  it('an email containing path-separator-like characters is decoded safely and matched exactly, not interpreted as extra path segments', async () => {
    const trickyEmail = 'weird/../name@example.com';
    store.addSuppression(DOMAIN, 'bounces', trickyEmail);

    const res = await del(`/v3/${DOMAIN}/bounces/${encodeURIComponent(trickyEmail)}`);
    expect(res.status).toBe(200);
    expect(store.isSuppressed(DOMAIN, 'bounces', trickyEmail)).toBe(false);
  });

  it('a %2F-encoded slash in the email decodes to the exact address, not a literal path split', async () => {
    const trickyEmail = 'a/b@example.com';
    store.addSuppression(DOMAIN, 'bounces', trickyEmail);

    const res = await del(`/v3/${DOMAIN}/bounces/${encodeURIComponent(trickyEmail)}`);
    expect(res.status).toBe(200);
    expect(store.isSuppressed(DOMAIN, 'bounces', trickyEmail)).toBe(false);
  });

  it('removing a suppression for one domain never touches the same email suppressed under another domain', async () => {
    store.addSuppression(DOMAIN, 'bounces', 'shared@example.com');
    store.addSuppression('other-tenant.example.com', 'bounces', 'shared@example.com');

    const res = await del(`/v3/${DOMAIN}/bounces/${encodeURIComponent('shared@example.com')}`);
    expect(res.status).toBe(200);
    expect(store.isSuppressed(DOMAIN, 'bounces', 'shared@example.com')).toBe(false);
    expect(store.isSuppressed('other-tenant.example.com', 'bounces', 'shared@example.com')).toBe(
      true
    );
  });

  it('401s without valid tenant credentials, and never removes the suppression', async () => {
    store.addSuppression(DOMAIN, 'bounces', 'member@example.com');
    const res = await fetch(
      `${server.baseUrl}/v3/${DOMAIN}/bounces/${encodeURIComponent('member@example.com')}`,
      { method: 'DELETE', headers: { Authorization: basicAuthHeader('api', 'wrong-key') } }
    );
    expect(res.status).toBe(401);
    expect(store.isSuppressed(DOMAIN, 'bounces', 'member@example.com')).toBe(true);
  });
});
