import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALLBACK_PATH, createTokenVerifier } from 'ghost-platform-identity/dist/index.js';
import { createShell } from '../src/shell/app.js';
import { Browser, serve, type Running } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

let app: Running;
let bind: () => Promise<string | null> = async () => 'bound';
let landing: () => Promise<string> = async () => '<p>HELLO</p>';
let extra: () => Promise<string> = async () => '<p>EXTRA</p>';
let act: (form: URLSearchParams) => Promise<string> = async () => '/extra';
const issuer = new FakeIssuer();
const logged: string[] = [];
let onError: (line: string) => void = (line) => void logged.push(line);

beforeAll(async () => {
  app = await serve((origin) =>
    createShell<string>({
      issuer: ISSUER,
      clientId: CLIENT_PORTAL,
      projectId: PROJECT_ID,
      redirectUri: `${origin}${CALLBACK_PATH}`,
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
      onError: (line) => onError(line),
      bind: () => bind(),
      landing: () => landing(),
      // '/' and '/logout' are the shell's own and must not be replaced.
      pages: { '/extra': () => extra(), '/': async () => '<p>SHADOWED</p>' },
      actions: { '/act': (_b, _i, form) => act(form), '/logout': async () => '/elsewhere' },
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

describe("the shell's extra pages and actions", () => {
  async function signedIn(): Promise<Browser> {
    bind = async () => 'bound';
    const browser = new Browser(app.origin);
    await browser.finish(issuer.issue(token()));
    return browser;
  }
  const post = (browser: Browser, path: string, body: string, origin = app.origin) =>
    browser.request(path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  it('serves an extra page to a signed-in browser and sends others to sign in', async () => {
    const browser = await signedIn();
    expect((await browser.request('/extra')).body).toContain('EXTRA');
    const lone = await new Browser(app.origin).request('/extra');
    expect(lone.status).toBe(302);
    extra = () => Promise.reject(new Error('secret detail'));
    const failed = await browser.request('/extra');
    expect(failed.status).toBe(500);
    expect(failed.body).toBe('FAILED');
    extra = async () => '<p>EXTRA</p>';
  });

  it('never lets an extra route replace the landing page or sign-out', async () => {
    const browser = await signedIn();
    const landed = await browser.request('/');
    expect(landed.body).toContain('HELLO');
    expect(landed.body).not.toContain('SHADOWED');
    const out = await post(browser, '/logout', '');
    expect(out.location).toBe('/login');
  });

  it('runs an action for a same-origin post, and answers a failure with a fixed refusal', async () => {
    const browser = await signedIn();
    let seen = '';
    act = async (form) => {
      seen = form.get('field') ?? '';
      return '/extra';
    };
    const ok = await post(browser, '/act', 'field=VALUE');
    expect(ok.status).toBe(303);
    expect(ok.location).toBe('/extra');
    expect(seen).toBe('VALUE');
    act = () => Promise.reject(new Error('secret detail'));
    const failed = await post(browser, '/act', 'field=VALUE');
    expect(failed.status).toBe(400);
    expect(failed.body).toBe('REFUSED');
    act = async () => '/extra';
    expect((await post(browser, '/act', 'field=V', 'https://evil.example')).status).toBe(403);
    expect((await browser.request('/act')).status).toBe(405);
  });
});

describe('the error lines the shell hands to its hook', () => {
  const SECRET = 'database password leaked here';

  it('names the failing step and the error, and carries no message, token or code', async () => {
    logged.length = 0;
    bind = () => Promise.reject(new Error(SECRET));
    const accessToken = token();
    const code = issuer.issue(accessToken);
    const browser = new Browser(app.origin);
    const reply = await browser.finish(code);
    expect(reply.status).toBe(503);
    expect(reply.body).toBe('UNAVAILABLE');
    expect(logged).toHaveLength(1);
    const line = logged[0] ?? '';
    expect(JSON.parse(line)).toEqual({ event: 'portal.error', step: 'bind', error: 'Error' });
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(accessToken);
    expect(line).not.toContain(code);
    bind = async () => 'bound';
  });

  it('names the landing and the action steps, and the error type as it is', async () => {
    logged.length = 0;
    bind = async () => 'bound';
    const browser = new Browser(app.origin);
    await browser.finish(issuer.issue(token()));
    landing = () => Promise.reject(new TypeError(SECRET));
    expect((await browser.request('/')).body).toBe('FAILED');
    landing = async () => '<p>HELLO</p>';
    act = () => Promise.reject(new RangeError(SECRET));
    const posted = await browser.request('/act', {
      method: 'POST',
      headers: { origin: app.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'field=VALUE',
    });
    expect(posted.body).toBe('REFUSED');
    act = async () => '/extra';
    expect(logged.map((line) => JSON.parse(line))).toEqual([
      { event: 'portal.error', step: 'landing', error: 'TypeError' },
      { event: 'portal.error', step: 'action', error: 'RangeError' },
    ]);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('is not what a failure turns on: a hook that throws changes no answer', async () => {
    onError = () => {
      throw new Error('the log is down');
    };
    try {
      bind = () => Promise.reject(new Error(SECRET));
      const reply = await new Browser(app.origin).finish(issuer.issue(token()));
      expect(reply.status).toBe(503);
      expect(reply.body).toBe('UNAVAILABLE');
    } finally {
      bind = async () => 'bound';
      onError = (line) => void logged.push(line);
    }
  });
});
