import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALLBACK_PATH, createTokenVerifier } from 'ghost-platform-identity/dist/index.js';
import { createShell } from '../src/shell/app.js';
import { Browser, serve, type Running } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';

// More than the 10,000 entries the shell once held for pending sign-ins.
const FLOOD = 10_050;
const BATCH = 50;
const LOGIN_COOKIE = 'portal_login';

let now = NOW;
const issuer = new FakeIssuer();
const verifiers: string[] = [];

/** The token endpoint, recording each PKCE verifier it is shown. */
const recordingFetch: typeof fetch = async (url, init) => {
  const body = new URLSearchParams(String(init?.body));
  verifiers.push(body.get('code_verifier') ?? '');
  return issuer.fetch(url, init);
};

const token = (): string => mint({ org: 'org-x', client: CLIENT_PORTAL, role: 'tenant-admin' });

function build(origin: string) {
  return createShell<string>({
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
    clock: () => now,
    fetch: recordingFetch,
    bind: async () => 'bound',
    landing: async () => '<p>HELLO</p>',
  });
}

let app: Running;
let other: Running;

beforeAll(async () => {
  app = await serve(build);
  other = await serve(build);
});

afterAll(async () => {
  await app.close();
  await other.close();
});

/** Unauthenticated starts from clients that keep nothing: the cheap attack. */
async function flood(origin: string, count: number): Promise<Map<number, number>> {
  const statuses = new Map<number, number>();
  for (let sent = 0; sent < count; sent += BATCH) {
    const size = Math.min(BATCH, count - sent);
    await Promise.all(
      Array.from({ length: size }, async () => {
        const reply = await fetch(`${origin}/login`, { redirect: 'manual' });
        await reply.arrayBuffer();
        statuses.set(reply.status, (statuses.get(reply.status) ?? 0) + 1);
      })
    );
  }
  return statuses;
}

const callback = (browser: Browser, code: string, state: string, cookie?: string) =>
  browser.request(`${CALLBACK_PATH}?code=${code}&state=${state}`, {
    ...(cookie === undefined ? {} : { headers: { cookie: `${LOGIN_COOKIE}=${cookie}` } }),
  });

describe('a flood of unauthenticated sign-in starts', () => {
  let flooded: Running;
  let early: Browser;
  let earlyState = '';
  let statuses: Map<number, number>;

  beforeAll(async () => {
    flooded = await serve(build);
    early = new Browser(flooded.origin);
    earlyState = await early.begin();
    statuses = await flood(flooded.origin, FLOOD);
  }, 60_000);

  afterAll(async () => {
    await flooded.close();
  });

  it('lets a new sign-in begin and finish', async () => {
    const browser = new Browser(flooded.origin);
    const started = await browser.request('/login');
    expect(started.status).toBe(302);
    expect(started.location).toContain(`${ISSUER}/oauth/v2/authorize`);
    const finished = await browser.finish(issuer.issue(token()));
    expect(finished.status).toBe(302);
    expect(finished.location).toBe('/');
    expect(browser.cookie('portal_session')).toBeDefined();
    expect((await browser.request('/')).body).toContain('HELLO');
  });

  it('does not evict a sign-in that began before it', async () => {
    const finished = await callback(early, issuer.issue(token()), earlyState);
    expect(finished.status).toBe(302);
    expect(early.cookie('portal_session')).toBeDefined();
  });

  it('answers every one of its own requests, refusing none', () => {
    expect(statuses.get(503) ?? 0).toBe(0);
    expect(statuses.get(302)).toBe(FLOOD);
  });
});

describe('a normal sign-in', () => {
  it('completes once, with a verifier that matches the challenge it was sent', async () => {
    const browser = new Browser(app.origin);
    const started = await browser.request('/login');
    const params = new URL(started.location ?? '').searchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    verifiers.length = 0;
    const finished = await callback(browser, issuer.issue(token()), params.get('state') ?? '');
    expect(finished.status).toBe(302);
    expect(finished.location).toBe('/');
    expect(verifiers).toHaveLength(1);
    const challenge = createHash('sha256')
      .update(verifiers[0] ?? '')
      .digest('base64url');
    expect(challenge).toBe(params.get('code_challenge'));
    const cookies = finished.headers.getSetCookie().join('\n');
    expect(cookies).toMatch(/portal_login=; .*Max-Age=0/);
    expect(cookies).toMatch(/portal_session=[^;]+; .*HttpOnly.*SameSite=Lax/);
  });

  it('is refused when the state does not match, or no sign-in was begun', async () => {
    const browser = new Browser(app.origin);
    await browser.begin();
    const wrong = await callback(browser, issuer.issue(token()), 'NOT-THE-STATE');
    expect(wrong.status).toBe(400);
    expect(wrong.body).toBe('SIGN_IN_REFUSED');
    expect(browser.cookie('portal_session')).toBeUndefined();

    const lone = new Browser(app.origin);
    const none = await callback(lone, issuer.issue(token()), 'ANY');
    expect(none.status).toBe(400);
    expect(lone.cookie('portal_session')).toBeUndefined();
  });

  it('cannot be used a second time from the same pending sign-in', async () => {
    const browser = new Browser(app.origin);
    const state = await browser.begin();
    const sealed = browser.cookie(LOGIN_COOKIE) ?? '';
    expect((await callback(browser, issuer.issue(token()), state)).status).toBe(302);

    const replay = new Browser(app.origin);
    const again = await callback(replay, issuer.issue(token()), state, sealed);
    expect(again.status).toBe(400);
    expect(replay.cookie('portal_session')).toBeUndefined();
  });

  it('is refused once its ten minutes are up', async () => {
    const browser = new Browser(app.origin);
    const state = await browser.begin();
    now = NOW + 601;
    try {
      const late = await callback(browser, issuer.issue(token()), state);
      expect(late.status).toBe(400);
      expect(browser.cookie('portal_session')).toBeUndefined();
    } finally {
      now = NOW;
    }
  });

  it('is refused when the pending sign-in has been altered or made elsewhere', async () => {
    const browser = new Browser(app.origin);
    const state = await browser.begin();
    const sealed = browser.cookie(LOGIN_COOKIE) ?? '';
    const flipped = `${sealed.slice(0, -1)}${sealed.endsWith('0') ? '1' : '0'}`;
    const altered = await callback(new Browser(app.origin), issuer.issue(token()), state, flipped);
    expect(altered.status).toBe(400);

    const foreign = new Browser(other.origin);
    const foreignState = await foreign.begin();
    const foreignSealed = foreign.cookie(LOGIN_COOKIE) ?? '';
    const crossed = await callback(
      new Browser(app.origin),
      issuer.issue(token()),
      foreignState,
      foreignSealed
    );
    expect(crossed.status).toBe(400);
  });

  it('keeps the PKCE verifier out of the cookie the browser carries', async () => {
    const browser = new Browser(app.origin);
    const state = await browser.begin();
    const sealed = browser.cookie(LOGIN_COOKIE) ?? '';
    verifiers.length = 0;
    await callback(browser, issuer.issue(token()), state);
    expect(verifiers).toHaveLength(1);
    expect(sealed).not.toContain(verifiers[0] ?? 'x');
    expect(sealed).not.toContain(state);
  });
});
