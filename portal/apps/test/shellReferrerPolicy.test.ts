import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALLBACK_PATH, createTokenVerifier } from 'ghost-platform-identity/dist/index.js';
import { createShell } from '../src/shell/app.js';
import { Browser, serve, type Running } from './browser.js';
import { CLIENT_PORTAL, ISSUER, jwks, NOW, PROJECT_ID } from './idp.js';

let app: Running;

beforeAll(async () => {
  app = await serve((origin) =>
    createShell<string>({
      issuer: ISSUER,
      clientId: CLIENT_PORTAL,
      projectId: PROJECT_ID,
      redirectUri: `${origin}${CALLBACK_PATH}`,
      publicOrigin: origin,
      cookiePrefix: 'portal',
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
      bind: async () => 'bound',
      landing: async () => '<p>HELLO</p>',
    })
  );
});

afterAll(async () => {
  await app.close();
});

describe('the shell sends a browser the Origin its own forms need', () => {
  // A browser puts `Origin: null` on a same-origin form POST when the page's
  // Referrer-Policy is `no-referrer`, and every action refuses an Origin that
  // is not the public origin. Only a real browser shows it (see the journey
  // test in test/journey), so the header is pinned here for the fast suite.
  it('is not no-referrer, and sends no Referer to another site', async () => {
    const reply = await new Browser(app.origin).request('/healthz');
    const policy = reply.headers.get('referrer-policy');
    expect(policy).toBe('same-origin');
    expect(['no-referrer', 'never']).not.toContain(policy);
  });
});
