import { afterEach, describe, expect, it } from 'vitest';
import { Browser } from './browser.js';
import { mint } from './idp.js';
import { NOT_THE_OWNER, requestId, startRig, TENANT_TWO, type Rig } from './ownerRequestsRig.js';

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const up = async (): Promise<Rig> => {
  rig = await startRig();
  rig.mock.store.createRequest(TENANT_TWO, 'essentials');
  return rig;
};

/** What a session that is not the owner's must get from every route of the queue. */
async function expectNothingReachable(r: Rig, browser: Browser): Promise<void> {
  const page = await browser.request('/requests');
  expect(page.status).toBe(302);
  expect(page.location).toBe('/login');
  const approve = await r.post(browser, '/requests/approve', { request_id: requestId(1) });
  expect(approve.status).toBe(302);
  expect(approve.location).toBe('/login');
  expect(r.approveCalls).toEqual([]);
  expect(r.mock.store.listRequests('approved')).toEqual([]);
}

describe('who may reach the queue and Approve', () => {
  for (const entry of NOT_THE_OWNER) {
    it(`refuses ${entry.why}, and approves nothing`, async () => {
      const r = await up();
      const browser = new Browser(r.console_.origin);
      const token = mint({ org: entry.org, client: entry.client, role: entry.role });
      expect((await browser.finish(r.issuer.issue(token))).status).toBe(403);
      await expectNothingReachable(r, browser);
    });
  }

  it('refuses a visitor with no session, and a forged session cookie', async () => {
    const r = await up();
    await expectNothingReachable(r, new Browser(r.console_.origin));
    const cookie = 'console_session=not-a-session; portal_session=not-a-session';
    const forged = new Browser(r.console_.origin);
    const page = await forged.request('/requests', { headers: { cookie } });
    expect(page.status).toBe(302);
    expect(page.location).toBe('/login');
    const post = await forged.request('/requests/approve', {
      method: 'POST',
      headers: {
        origin: r.console_.origin,
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `request_id=${requestId(1)}`,
    });
    expect(post.status).toBe(302);
    expect(post.location).toBe('/login');
    expect(r.approveCalls).toEqual([]);
  });

  it('lets the owner through, as the control case', async () => {
    const r = await up();
    const browser = await r.ownerBrowser();
    expect((await browser.request('/requests')).status).toBe(200);
    const reply = await r.post(browser, '/requests/approve', { request_id: requestId(1) });
    expect(reply.status).toBe(303);
    expect(r.approveCalls).toEqual([requestId(1)]);
    expect(r.mock.store.listRequests('approved')).toHaveLength(1);
  });
});
