/**
 * A test identity provider that speaks OIDC over HTTP, for the browser journey
 * and for anything else that needs a real issuer to fetch from.
 *
 * TEST CODE ONLY. It lives under `test/`, which the build config leaves out of
 * `dist`, the image's ignore file leaves out of the build context, and a test
 * (`testOnlyGuard.test.ts`) keeps out of every import in `src/`. It also
 * refuses to start under `NODE_ENV=production` and listens on loopback alone,
 * so even a stray import could not serve a sign-in on a public address.
 *
 * What it serves, shaped as Zitadel's are, which is what the shell's PKCE flow
 * (`src/shell/oidc.ts`) and the token verifier expect:
 *   GET  /.well-known/openid-configuration   discovery
 *   GET  /oauth/v2/keys                      the signing key set
 *   GET  /oauth/v2/authorize                 a page offering each test user
 *   POST /oauth/v2/authorize/select          the choice; redirects with a code
 *   POST /oauth/v2/token                     the code and PKCE verifier for a token
 *
 * It asks for no password: choosing a user is the whole sign-in. It holds
 * every code and pending request in memory and forgets them on `close`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jwks, mint } from './idp.js';

export const AUTHORIZE_PATH = '/oauth/v2/authorize';
export const SELECT_PATH = '/oauth/v2/authorize/select';
export const TOKEN_PATH = '/oauth/v2/token';
export const KEYS_PATH = '/oauth/v2/keys';
export const DISCOVERY_PATH = '/.well-known/openid-configuration';

const CODE_SECONDS = 60;
const TOKEN_SECONDS = 3600;
const MAX_BODY_BYTES = 8192;

/** A person the test provider can sign in. The `id` is what the page's button posts. */
export interface TestUser {
  readonly id: string;
  /** Shown on the button as `SIGN_IN_AS_<LABEL>`; ALL_CAPS by convention. */
  readonly label: string;
  readonly subject: string;
  /** The organisation the token carries as its resource owner. */
  readonly org: string;
  readonly role: string;
}

export interface TestClient {
  readonly clientId: string;
  /** Matched exactly; an unregistered one is refused and never redirected to. */
  readonly redirectUris: readonly string[];
}

export interface TestIdpOptions {
  readonly users: readonly TestUser[];
  readonly clients: readonly TestClient[];
  /** Seconds since the epoch. Defaults to the wall clock. */
  readonly clock?: () => number;
}

export interface TestIdp {
  /** `http://127.0.0.1:<port>`, the value for `PORTAL_ISSUER_URL`. */
  readonly issuer: string;
  /** Registers a redirect URI for a known client, for an application whose port is chosen later. */
  allowRedirect(clientId: string, redirectUri: string): void;
  close(): Promise<void>;
}

interface Pending {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
  readonly expiresAt: number;
}

interface Issued extends Pending {
  readonly user: TestUser;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const sha256Challenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string,
  extra: Record<string, string> = {}
): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  });
  response.end(body);
}

const json = (response: ServerResponse, status: number, body: unknown): void =>
  send(response, status, 'application/json', JSON.stringify(body));

const page = (response: ServerResponse, status: number, body: string): void =>
  send(
    response,
    status,
    'text/html; charset=utf-8',
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TEST_IDP</title></head><body>${body}</body></html>`
  );

async function readForm(request: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Starts the provider on an ephemeral loopback port. Throws, and starts
 * nothing, when `NODE_ENV` is `production`.
 */
export async function startTestIdp(options: TestIdpOptions): Promise<TestIdp> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('the test identity provider does not run in production');
  }
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const users = new Map(options.users.map((user) => [user.id, user]));
  const redirects = new Map(options.clients.map((c) => [c.clientId, new Set(c.redirectUris)]));
  const pending = new Map<string, Pending>();
  const codes = new Map<string, Issued>();
  let issuer = '';

  const dispatch = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://idp.invalid');
    const path = url.pathname;

    if (method === 'GET' && path === DISCOVERY_PATH) {
      return json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
        token_endpoint: `${issuer}${TOKEN_PATH}`,
        jwks_uri: `${issuer}${KEYS_PATH}`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['openid'],
      });
    }
    if (method === 'GET' && path === KEYS_PATH) return json(response, 200, { keys: jwks });

    if (method === 'GET' && path === AUTHORIZE_PATH) {
      const query = url.searchParams;
      const clientId = query.get('client_id') ?? '';
      const redirectUri = query.get('redirect_uri') ?? '';
      const challenge = query.get('code_challenge') ?? '';
      const state = query.get('state') ?? '';
      // A client or redirect that is not registered is shown an error, never redirected to.
      if (!redirects.get(clientId)?.has(redirectUri)) {
        return page(response, 400, '<p>TEST_IDP_UNKNOWN_CLIENT_OR_REDIRECT</p>');
      }
      if (
        query.get('response_type') !== 'code' ||
        query.get('code_challenge_method') !== 'S256' ||
        challenge === ''
      ) {
        return page(response, 400, '<p>TEST_IDP_REQUEST_REFUSED</p>');
      }
      const id = randomBytes(24).toString('base64url');
      pending.set(id, {
        clientId,
        redirectUri,
        challenge,
        state,
        expiresAt: clock() + CODE_SECONDS,
      });
      const buttons = [...users.values()]
        .map(
          (user) =>
            `<form method="post" action="${SELECT_PATH}"><input type="hidden" name="request" value="${id}"><input type="hidden" name="user" value="${escapeHtml(user.id)}"><button type="submit">SIGN_IN_AS_${escapeHtml(user.label)}</button></form>`
        )
        .join('');
      return page(
        response,
        200,
        `<h1>TEST_IDP_SIGN_IN</h1>${buttons}<form method="post" action="${SELECT_PATH}"><input type="hidden" name="request" value="${id}"><input type="hidden" name="user" value=""><button type="submit">DENY_ACCESS</button></form>`
      );
    }

    if (method === 'POST' && path === SELECT_PATH) {
      const form = await readForm(request);
      if (form === null) return page(response, 413, '<p>TEST_IDP_TOO_LARGE</p>');
      const id = form.get('request') ?? '';
      const found = pending.get(id);
      pending.delete(id);
      if (found === undefined || found.expiresAt <= clock()) {
        return page(response, 400, '<p>TEST_IDP_REQUEST_EXPIRED</p>');
      }
      const target = new URL(found.redirectUri);
      if (found.state !== '') target.searchParams.set('state', found.state);
      const user = users.get(form.get('user') ?? '');
      if (user === undefined) {
        target.searchParams.set('error', 'access_denied');
        return send(response, 302, 'text/plain', '', { location: target.toString() });
      }
      const code = randomBytes(24).toString('base64url');
      codes.set(code, { ...found, user, expiresAt: clock() + CODE_SECONDS });
      target.searchParams.set('code', code);
      return send(response, 302, 'text/plain', '', { location: target.toString() });
    }

    if (method === 'POST' && path === TOKEN_PATH) {
      const form = await readForm(request);
      if (form === null) return json(response, 413, { error: 'invalid_request' });
      const refuse = (): void => json(response, 400, { error: 'invalid_grant' });
      const code = form.get('code') ?? '';
      const issued = codes.get(code);
      // A code is spent by the first attempt to redeem it, right or wrong.
      codes.delete(code);
      if (
        form.get('grant_type') !== 'authorization_code' ||
        issued === undefined ||
        issued.expiresAt <= clock() ||
        form.get('client_id') !== issued.clientId ||
        form.get('redirect_uri') !== issued.redirectUri ||
        !sameText(sha256Challenge(form.get('code_verifier') ?? ''), issued.challenge)
      ) {
        return refuse();
      }
      const now = clock();
      const accessToken = mint({
        issuer,
        org: issued.user.org,
        client: issued.clientId,
        role: issued.user.role,
        subject: issued.user.subject,
        exp: now + TOKEN_SECONDS,
      });
      return json(response, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: TOKEN_SECONDS,
      });
    }

    return page(response, 404, '<p>TEST_IDP_NOT_FOUND</p>');
  };

  const server = createServer((request, response) => {
    dispatch(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'server_error' });
    });
  });
  // Loopback alone, and no parameter to change it.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    allowRedirect(clientId, redirectUri) {
      const set = redirects.get(clientId);
      if (set === undefined) throw new Error('unknown client');
      set.add(redirectUri);
    },
    close: () =>
      new Promise<void>((resolve) => {
        pending.clear();
        codes.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
