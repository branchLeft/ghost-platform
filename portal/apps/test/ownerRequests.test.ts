import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_CREDENTIAL,
  requestId,
  startRig,
  TENANT_ONE,
  TENANT_THREE,
  TENANT_TWO,
  type Rig,
} from './ownerRequestsRig.js';

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const up = async (options?: Parameters<typeof startRig>[0]): Promise<Rig> => {
  rig = await startRig(options);
  return rig;
};

describe('the owner console request queue', () => {
  it('shows an empty-state placeholder when nothing is pending', async () => {
    const r = await up();
    const page = await (await r.ownerBrowser()).request('/requests');
    expect(page.status).toBe(200);
    expect(page.body).toContain('REQUESTS_EMPTY');
    expect(page.body).toContain('NAV_REQUESTS');
    expect(page.body).not.toContain('APPROVE');
  });

  it("lists the mock's pending requests, oldest first, each with its id, tier and time", async () => {
    const r = await up();
    r.mock.store.createRequest(TENANT_TWO, 'essentials');
    r.mock.store.createRequest(TENANT_ONE, 'professional-enquiry');
    r.mock.store.createRequest(TENANT_THREE, 'essentials');
    const page = await (await r.ownerBrowser()).request('/requests');
    const body = page.body;
    const [first, second, third] = [requestId(1), requestId(2), requestId(3)].map((id) =>
      body.indexOf(id)
    );
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first ?? 0);
    expect(third).toBeGreaterThan(second ?? 0);
    expect(body).toContain('TIER_ESSENTIALS');
    expect(body).toContain('TIER_PROFESSIONAL_ENQUIRY');
    expect(body).toContain('2026-01-01T00:00:00.000Z');
    expect(body).not.toContain('REQUESTS_EMPTY');
    // One Approve button per approvable row; an enquiry has none.
    expect(body.match(/<button type="submit">APPROVE<\/button>/g)).toHaveLength(2);
  });

  it('pressing Approve once approves the request in the mock and removes it from the queue', async () => {
    const r = await up();
    r.mock.store.createRequest(TENANT_TWO, 'essentials');
    const browser = await r.ownerBrowser();
    const reply = await r.post(browser, '/requests/approve', { request_id: requestId(1) });
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/requests');
    expect(r.mock.store.listRequests('approved').map((x) => x.request_id)).toEqual([requestId(1)]);
    expect(r.mock.store.listRequests('pending')).toEqual([]);
    const page = await browser.request('/requests');
    expect(page.body).toContain('REQUESTS_EMPTY');
    expect(page.body).not.toContain('<button type="submit">APPROVE</button>');
    // The queue shows it as approved.
    expect(page.body).toContain('REQUESTS_APPROVED_HEADING');
    expect(page.body).toContain(requestId(1));
  });

  it('a double submit and a replayed POST leave one approval and the same page', async () => {
    const r = await up();
    r.mock.store.createRequest(TENANT_TWO, 'essentials');
    const browser = await r.ownerBrowser();
    const both = await Promise.all([
      r.post(browser, '/requests/approve', { request_id: requestId(1) }),
      r.post(browser, '/requests/approve', { request_id: requestId(1) }),
    ]);
    const replay = await r.post(browser, '/requests/approve', { request_id: requestId(1) });
    for (const reply of [...both, replay]) {
      expect(reply.status).toBe(303);
      expect(reply.location).toBe('/requests');
    }
    const approved = r.mock.store.listRequests('approved');
    expect(approved).toHaveLength(1);
    expect(approved[0]?.approval?.approval_id).toBe(requestId(2));
    expect(r.mock.store.getTenant(TENANT_TWO)?.tier).toBe('essentials');
    const page = await browser.request('/requests');
    expect(page.body.split(requestId(1))).toHaveLength(2);
  });

  it('answers a placeholder line for an id that is not a request, and approves nothing', async () => {
    const r = await up();
    r.mock.store.createRequest(TENANT_TWO, 'essentials');
    const browser = await r.ownerBrowser();
    for (const id of [requestId(99), 'not-a-uuid', '../tenants', '']) {
      const reply = await r.post(browser, '/requests/approve', { request_id: id });
      expect(reply.status).toBe(303);
      expect(reply.location).toBe('/requests/not-found');
    }
    const noField = await r.post(browser, '/requests/approve', {});
    expect(noField.location).toBe('/requests/not-found');
    const page = await browser.request('/requests/not-found');
    expect(page.status).toBe(200);
    expect(page.body).toContain('REQUEST_NOT_FOUND');
    expect(r.mock.store.listRequests('approved')).toEqual([]);
    // Only the well-formed unknown id reached the API at all.
    expect(r.approveCalls).toEqual([requestId(99)]);
  });

  it('an enquiry cannot be approved: the contract refuses it and nothing changes', async () => {
    const r = await up();
    r.mock.store.createRequest(TENANT_ONE, 'professional-enquiry');
    const browser = await r.ownerBrowser();
    const reply = await r.post(browser, '/requests/approve', { request_id: requestId(1) });
    expect(reply.location).toBe('/requests/not-approvable');
    expect((await browser.request(reply.location ?? '')).body).toContain('REQUEST_NOT_APPROVABLE');
    expect(r.mock.store.listRequests('approved')).toEqual([]);
  });

  it('a console holding the wrong credential approves nothing and shows a fixed error', async () => {
    const r = await up({ consoleCredential: 'TEST_WRONG_CREDENTIAL' });
    r.mock.store.createRequest(TENANT_TWO, 'essentials');
    const browser = await r.ownerBrowser();
    const reply = await r.post(browser, '/requests/approve', { request_id: requestId(1) });
    expect(reply.status).toBe(400);
    expect(reply.body).toBe('REFUSED');
    expect(r.mock.store.listRequests('approved')).toEqual([]);
    const page = await browser.request('/requests');
    expect(page.status).toBe(500);
    expect(page.body).toBe('FAILED');
    expect(r.errors.every((line) => !line.includes('TEST_WRONG_CREDENTIAL'))).toBe(true);
    expect(OWNER_CREDENTIAL).not.toBe('TEST_WRONG_CREDENTIAL');
  });

  it('an API that is down answers a fixed error, not a hang or a detail', async () => {
    const r = await up();
    const browser = await r.ownerBrowser();
    await r.api.close();
    const page = await browser.request('/requests');
    expect(page.status).toBe(500);
    expect(page.body).toBe('FAILED');
    const reply = await r.post(browser, '/requests/approve', { request_id: requestId(1) });
    expect(reply.status).toBe(400);
    expect(reply.body).toBe('REFUSED');
    expect(r.errors.some((line) => line.includes('ProvisioningError'))).toBe(true);
  });

  it('without the provisioning URL, the page, the action and the nav entry are absent', async () => {
    const r = await up({ provisioned: false });
    const browser = await r.ownerBrowser();
    const home = await browser.request('/');
    expect(home.status).toBe(200);
    expect(home.body).not.toContain('NAV_REQUESTS');
    expect(home.body).toContain('NAV_HOME');
    expect((await browser.request('/requests')).status).toBe(404);
    expect((await r.post(browser, '/requests/approve', { request_id: requestId(1) })).status).toBe(
      404
    );
  });

  it('with it, the nav entry is on the landing page', async () => {
    const r = await up();
    const home = await (await r.ownerBrowser()).request('/');
    expect(home.body).toContain('NAV_REQUESTS');
  });

  it('refuses an approval posted from another origin, and approves nothing', async () => {
    const r = await up();
    r.mock.store.createRequest(TENANT_TWO, 'essentials');
    const browser = await r.ownerBrowser();
    const reply = await browser.request('/requests/approve', {
      method: 'POST',
      headers: {
        origin: 'https://elsewhere.example.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `request_id=${requestId(1)}`,
    });
    expect(reply.status).toBe(403);
    expect(r.approveCalls).toEqual([]);
  });

  it('keeps every user-visible string a placeholder', async () => {
    const r = await up();
    r.mock.store.createRequest(TENANT_TWO, 'essentials');
    const browser = await r.ownerBrowser();
    await r.post(browser, '/requests/approve', { request_id: requestId(1) });
    r.mock.store.createRequest(TENANT_ONE, 'essentials');
    const pages = ['/requests', '/requests/not-found', '/requests/not-approvable'];
    for (const path of pages) {
      const text = (await browser.request(path)).body
        .replace(/<[^>]*>/g, ' ')
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27}|\d{4}-\d\d-\d\dT[\d:.]+Z/g, ' ');
      const words = text.split(/\s+/).filter((word) => word !== '' && word !== 'OWNER_CONSOLE');
      expect(words.filter((word) => !/^[A-Z][A-Z0-9_]*$/.test(word))).toEqual([]);
    }
  });
});
