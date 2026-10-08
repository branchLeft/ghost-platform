import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TokenVerifier } from 'ghost-platform-identity/dist/index.js';
import { cookieName, parseCookies, setCookie } from './cookies.js';
import { escapeHtml, renderPage, STYLESHEET, type NavItem } from './html.js';
import { authorizeUrl, expiryOf, exchangeCode, newPkce, type OidcClient } from './oidc.js';
import { ExpiringStore, type SessionRecord } from './sessions.js';

const LOGIN_TTL_SECONDS = 600;
const DEFAULT_SESSION_SECONDS = 3600;
const TOKEN_EXCHANGE_TIMEOUT_MS = 5000;

const MAX_FORM_BYTES = 4096;

const SESSION_COOKIE = 'portal_session';
const LOGIN_COOKIE = 'portal_login';

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export interface Signed {
  readonly subject: string;
  readonly orgId: string;
}

export interface ShellOptions<S> extends OidcClient {
  /** The one verifier of this application: its own client, role and organisations. */
  readonly verifier: TokenVerifier;
  /** The public origin, for example `https://portal.example`. Sign-in returns here. */
  readonly publicOrigin: string;
  readonly title: string;
  readonly nav: readonly NavItem[];
  readonly signOutLabel: string;
  /**
   * Runs once, at sign-in, with the organisation the verified token carries.
   * What it returns is kept in the session and handed to `landing`; null
   * refuses the sign-in. Nothing from a later request reaches it.
   */
  readonly bind: (identity: Signed) => Promise<S | null>;
  /** Renders the landing area from the session alone; the request is not an argument. */
  readonly landing: (bound: S, identity: Signed) => Promise<string>;
  /**
   * Further signed-in pages by path, rendered like the landing area from the
   * session alone. A path outside this set, or any that shadows the shell's
   * own, is not served.
   */
  readonly pages?: Readonly<Record<string, (bound: S, identity: Signed) => Promise<string>>>;
  /**
   * Signed-in form posts by path. Each runs with the session's bound value and
   * the posted fields, and returns the path to redirect to. A post from any
   * origin but this application's is refused, as is a missing origin.
   */
  readonly actions?: Readonly<
    Record<string, (bound: S, identity: Signed, form: URLSearchParams) => Promise<string>>
  >;
  readonly clock?: () => number;
  readonly fetch?: typeof fetch;
  readonly sessionSeconds?: number;
  /** False only for local development over plain HTTP. */
  readonly secureCookies?: boolean;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

interface PendingLogin {
  readonly verifier: string;
  readonly expiresAt: number;
}

function send(response: ServerResponse, status: number, type: string, body: string, extra = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
  response.end(body);
}

const text = (response: ServerResponse, status: number, body: string, extra = {}): void =>
  send(response, status, 'text/plain; charset=utf-8', body, extra);

/**
 * One application's whole HTTP surface. The tenant portal and the owner
 * console each build their own with their own client, verifier and binding;
 * this holds no tenant logic and imports neither storage entry point.
 */
export function createShell<S>(options: ShellOptions<S>): Handler {
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const fetchImpl = options.fetch ?? fetch;
  const secure = options.secureCookies ?? true;
  const sessionSeconds = options.sessionSeconds ?? DEFAULT_SESSION_SECONDS;
  const sessionName = cookieName(SESSION_COOKIE, secure);
  const loginName = cookieName(LOGIN_COOKIE, secure);
  const sessions = new ExpiringStore<SessionRecord<S>>(clock);
  const logins = new ExpiringStore<PendingLogin & { readonly state: string }>(clock);

  async function signIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', options.publicOrigin);
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const cookies = parseCookies(request.headers.cookie);
    const clearLogin = setCookie(loginName, '', { maxAge: 0, secure });
    const pending = logins.take(cookies.get(loginName));
    if (!pending || state === '' || pending.state !== state || code === '') {
      return text(response, 400, 'SIGN_IN_REFUSED', { 'set-cookie': clearLogin });
    }
    const token = await exchangeCode(
      options,
      code,
      pending.verifier,
      fetchImpl,
      TOKEN_EXCHANGE_TIMEOUT_MS
    );
    const verdict = token === null ? null : await options.verifier.verify(token);
    if (token === null || verdict === null || !verdict.ok) {
      return text(response, 403, 'SIGN_IN_REFUSED', { 'set-cookie': clearLogin });
    }
    const identity: Signed = { subject: verdict.subject, orgId: verdict.orgId };
    let bound: S | null;
    try {
      bound = await options.bind(identity);
    } catch {
      return text(response, 503, 'UNAVAILABLE', { 'set-cookie': clearLogin });
    }
    if (bound === null) return text(response, 403, 'SIGN_IN_REFUSED', { 'set-cookie': clearLogin });
    const now = clock();
    const tokenExpiry = expiryOf(token) ?? now;
    const expiresAt = Math.min(now + sessionSeconds, tokenExpiry);
    const id = sessions.put({ ...identity, expiresAt, bound });
    if (id === null) return text(response, 503, 'UNAVAILABLE', { 'set-cookie': clearLogin });
    response.writeHead(302, {
      ...SECURITY_HEADERS,
      location: '/',
      'set-cookie': [clearLogin, setCookie(sessionName, id, { maxAge: expiresAt - now, secure })],
    });
    response.end();
  }

  function beginLogin(response: ServerResponse): void {
    const pkce = newPkce();
    const state = randomBytes(32).toString('base64url');
    const id = logins.put({
      verifier: pkce.verifier,
      state,
      expiresAt: clock() + LOGIN_TTL_SECONDS,
    });
    if (id === null) return text(response, 503, 'UNAVAILABLE');
    response.writeHead(302, {
      ...SECURITY_HEADERS,
      location: authorizeUrl(options, state, pkce.challenge),
      'set-cookie': setCookie(loginName, id, { maxAge: LOGIN_TTL_SECONDS, secure }),
    });
    response.end();
  }

  async function landing(
    request: IncomingMessage,
    response: ServerResponse,
    render: (bound: S, identity: Signed) => Promise<string> = options.landing
  ): Promise<void> {
    const cookies = parseCookies(request.headers.cookie);
    const session = sessions.get(cookies.get(sessionName));
    if (!session) {
      response.writeHead(302, { ...SECURITY_HEADERS, location: '/login' });
      response.end();
      return;
    }
    let body: string;
    try {
      body = await render(session.bound, {
        subject: session.subject,
        orgId: session.orgId,
      });
    } catch {
      return text(response, 500, 'FAILED');
    }
    send(
      response,
      200,
      'text/html; charset=utf-8',
      renderPage({
        title: options.title,
        nav: options.nav,
        signOutLabel: options.signOutLabel,
        body,
      })
    );
  }

  async function readForm(request: IncomingMessage): Promise<URLSearchParams | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_FORM_BYTES) return null;
      chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  async function act(
    request: IncomingMessage,
    response: ServerResponse,
    run: (bound: S, identity: Signed, form: URLSearchParams) => Promise<string>
  ): Promise<void> {
    if (request.headers.origin !== options.publicOrigin) return text(response, 403, 'REFUSED');
    const session = sessions.get(parseCookies(request.headers.cookie).get(sessionName));
    if (!session) {
      response.writeHead(302, { ...SECURITY_HEADERS, location: '/login' });
      response.end();
      return;
    }
    const form = await readForm(request);
    if (form === null) return text(response, 413, 'TOO_LARGE');
    let location: string;
    try {
      location = await run(session.bound, { subject: session.subject, orgId: session.orgId }, form);
    } catch {
      return text(response, 400, 'REFUSED');
    }
    response.writeHead(303, { ...SECURITY_HEADERS, location });
    response.end();
  }

  function signOut(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== options.publicOrigin)
      return text(response, 403, 'REFUSED');
    sessions.delete(parseCookies(request.headers.cookie).get(sessionName));
    response.writeHead(302, {
      ...SECURITY_HEADERS,
      location: '/login',
      'set-cookie': setCookie(sessionName, '', { maxAge: 0, secure }),
    });
    response.end();
  }

  return async (request, response) => {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', options.publicOrigin).pathname;
    const routes: Record<string, { method: string; run: () => void | Promise<void> }> = {
      '/healthz': { method: 'GET', run: () => text(response, 200, 'ok') },
      '/shell.css': { method: 'GET', run: () => send(response, 200, 'text/css', STYLESHEET) },
      '/login': { method: 'GET', run: () => beginLogin(response) },
      '/callback': { method: 'GET', run: () => signIn(request, response) },
      '/logout': { method: 'POST', run: () => signOut(request, response) },
      '/': { method: 'GET', run: () => landing(request, response) },
    };
    for (const [extra, render] of Object.entries(options.pages ?? {})) {
      if (!Object.hasOwn(routes, extra)) {
        routes[extra] = { method: 'GET', run: () => landing(request, response, render) };
      }
    }
    for (const [extra, run] of Object.entries(options.actions ?? {})) {
      if (!Object.hasOwn(routes, extra)) {
        routes[extra] = { method: 'POST', run: () => act(request, response, run) };
      }
    }
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (!route) return text(response, 404, 'NOT_FOUND');
    if (route.method !== method) return text(response, 405, 'METHOD_NOT_ALLOWED');
    try {
      await route.run();
    } catch {
      if (!response.headersSent) text(response, 500, 'FAILED');
    }
  };
}

export { escapeHtml };
