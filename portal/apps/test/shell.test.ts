import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier } from 'ghost-platform-identity/dist/index.js';
import { createShell } from '../src/shell/app.js';
import { Browser, serve, type Running } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

let app: Running;
let bind: () => Promise<string | null> = async () => 'bound';
let landing: () => Promise<string> = async () => '<p>HELLO</p>';
const issuer = new FakeIssuer();

beforeAll(async () => {
  app = await serve((origin) =>
    createShell<string>({
      issuer: ISSUER,
      clientId: CLIENT_PORTAL,
      projectId: PROJECT_ID,
      redirectUri: `${origin}/callback`,
      publicOrigin: origin,
      verifier: createTokenVerifier({
        issuer: ISSUER,
        clientId: CLIENT_PORTAL,
        requiredRole: 'tenant-admin',
        allowedOrgIds: new Set(['org-x']),
        clock: () => NOW,
        fetchKeys: async () => jwks,
      }),
      secureCookies: false,
      title: 'T',
      nav: [],
      signOutLabel: 'OUT',
      clock: () => NOW,
      fetch: issuer.fetch,
      bind: () => bind(),
      landing: () => landing(),
    })
  );
});

afterAll(async () => {
  await app.close();
});

const token = (): string => mint({ org: 'org-x', client: CLIENT_PORTAL, role: 'tenant-admin' });

describe('the shell when its application misbehaves', () => {
  it('opens no session when binding fails, and says nothing of why', async () => {
    bind = () => Promise.reject(new Error('database password leaked here'));
    const browser = new Browser(app.origin);
    const reply = await browser.finish(issuer.issue(token()));
    expect(reply.status).toBe(503);
    expect(reply.body).toBe('UNAVAILABLE');
    expect(browser.cookie('portal_session')).toBeUndefined();
  });

  it('opens no session when binding finds no one', async () => {
    bind = async () => null;
    const browser = new Browser(app.origin);
    expect((await browser.finish(issuer.issue(token()))).status).toBe(403);
    expect(browser.cookie('portal_session')).toBeUndefined();
  });

  it('answers a failing landing with a fixed error', async () => {
    bind = async () => 'bound';
    landing = () => Promise.reject(new Error('secret detail'));
    const browser = new Browser(app.origin);
    await browser.finish(issuer.issue(token()));
    const reply = await browser.request('/');
    expect(reply.status).toBe(500);
    expect(reply.body).toBe('FAILED');
    landing = async () => '<p>HELLO</p>';
    expect((await browser.request('/')).body).toContain('HELLO');
  });
});
