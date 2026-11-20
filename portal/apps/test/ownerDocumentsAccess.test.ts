import { afterEach, describe, expect, it } from 'vitest';
import { Browser } from './browser.js';
import { mint } from './idp.js';
import { startDocumentsRig, TERMS_FORM, type DocumentsRig } from './ownerDocumentsRig.js';
import { NOT_THE_OWNER } from './ownerRequestsRig.js';

let rig: DocumentsRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const up = async (): Promise<DocumentsRig> => {
  rig = await startDocumentsRig();
  return rig;
};

/** What a session that is not the owner's must get from the screen and from Publish. */
async function expectNothingReachable(r: DocumentsRig, browser: Browser): Promise<void> {
  const page = await browser.request('/documents');
  expect(page.status).toBe(302);
  expect(page.location).toBe('/login');
  const publish = await r.post(browser, '/documents/publish', TERMS_FORM);
  expect(publish.status).toBe(302);
  expect(publish.location).toBe('/login');
  expect(r.published).toEqual([]);
}

describe('who may reach the documents screen and Publish', () => {
  for (const entry of NOT_THE_OWNER) {
    it(`refuses ${entry.why}, and publishes nothing`, async () => {
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
    const page = await forged.request('/documents', { headers: { cookie } });
    expect(page.status).toBe(302);
    expect(page.location).toBe('/login');
    const post = await forged.request('/documents/publish', {
      method: 'POST',
      headers: {
        origin: r.console_.origin,
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(TERMS_FORM).toString(),
    });
    expect(post.status).toBe(302);
    expect(post.location).toBe('/login');
    expect(r.published).toEqual([]);
  });

  it('refuses the owner posting from another origin, or from none', async () => {
    const r = await up();
    const browser = await r.ownerBrowser();
    const body = new URLSearchParams(TERMS_FORM).toString();
    const type = 'application/x-www-form-urlencoded';
    const other = await browser.request('/documents/publish', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': type },
      body,
    });
    expect(other.status).toBe(403);
    const none = await browser.request('/documents/publish', {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });
    expect(none.status).toBe(403);
    expect(r.published).toEqual([]);
  });

  it('serves no page under GET to a post-only route, and no post to the page', async () => {
    const r = await up();
    const browser = await r.ownerBrowser();
    expect((await browser.request('/documents/publish')).status).toBe(405);
    expect((await r.post(browser, '/documents', TERMS_FORM)).status).toBe(405);
    expect(r.published).toEqual([]);
  });

  it('lets the owner through, as the control case', async () => {
    const r = await up();
    const browser = await r.ownerBrowser();
    const page = await browser.request('/documents');
    expect(page.status).toBe(200);
    expect(page.body).toContain('NAV_DOCUMENTS');
    for (const kind of ['terms', 'usage', 'subprocessors']) {
      expect(page.body).toContain(`<option value="${kind}">`);
    }
    const reply = await r.post(browser, '/documents/publish', TERMS_FORM);
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/documents/published');
    expect(r.published).toEqual([
      {
        kind: 'terms',
        title: 'TEST_TERMS_TITLE',
        body: 'TEST_TERMS_BODY',
        effectiveAt: new Date('2026-12-01T00:00:00.000Z'),
      },
    ]);
    expect((await browser.request('/documents/published')).body).toContain('DOCUMENT_PUBLISHED');
  });
});
