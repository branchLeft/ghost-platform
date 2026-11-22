// The two web servers the suite runs itself, in this process:
//
//  - the portal stand-in. The real portal needs a database and an identity
//    provider; what the isolation case tests is how its cookies are named and
//    attributed, and that code is pure, so the stand-in calls the portal's own
//    cookie functions (never a copy) and is otherwise empty.
//  - the attacker's own site, on a different registrable domain from the
//    tenants, for the forged cross-site requests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cookieName, parseCookies, setCookie } from '../../../portal/apps/src/shell/cookies.ts';

export const PORTAL_PREFIX = 'portal';
export const PORTAL_LOGIN_PATH = '/login';
export const PORTAL_SIGNED_IN_PATH = '/signed-in';
export const PORTAL_WHOAMI_PATH = '/whoami';
const SESSION_SECONDS = 3600;

export interface PortalStubOptions {
  /** True is the production wiring: every cookie is `__Host-` prefixed and Secure. False is the sabotage. */
  readonly hostPrefixed: boolean;
}

export interface Listening {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

function listen(server: Server): Promise<Listening> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function send(res: ServerResponse, status: number, body: string, cookies: string[] = []): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}),
  });
  res.end(body);
}

export interface PortalStub extends Listening {
  /** Changes the wiring between phases without moving the port. */
  setHostPrefixed(prefixed: boolean): void;
}

export async function startPortalStub(options: PortalStubOptions): Promise<PortalStub> {
  let prefixed = options.hostPrefixed;
  const names = () => ({
    session: cookieName(`${PORTAL_PREFIX}_session`, prefixed),
    login: cookieName(`${PORTAL_PREFIX}_login`, prefixed),
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://portal.invalid').pathname;
    const { session, login } = names();
    if (path === PORTAL_LOGIN_PATH) {
      send(res, 200, 'login', [
        setCookie(login, 'genuine-login-value', { maxAge: 600, secure: prefixed }),
      ]);
      return;
    }
    if (path === PORTAL_SIGNED_IN_PATH) {
      send(res, 200, 'signed in', [
        setCookie(session, 'genuine-session-value', { maxAge: SESSION_SECONDS, secure: prefixed }),
      ]);
      return;
    }
    if (path === PORTAL_WHOAMI_PATH) {
      const read = parseCookies(req.headers.cookie).get(session) ?? null;
      send(res, 200, JSON.stringify({ session: read }));
      return;
    }
    send(res, 404, 'not found');
  });
  const listening = await listen(server);
  return { ...listening, setHostPrefixed: (value) => void (prefixed = value) };
}

export interface EvilServer extends Listening {
  readonly seen: string[];
  /** Sets the URL the attacker's pages forge a request to. Held here, never read from a request. */
  aimAt(target: string): void;
}

/** The attacker's site: a page that forges a POST to `target`, by form or by fetch. */
export async function startEvilServer(): Promise<EvilServer> {
  const seen: string[] = [];
  let target = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://evil.invalid');
    seen.push(`${req.method ?? 'GET'} ${url.pathname}`);
    const escaped = JSON.stringify(target).replaceAll('<', '\\u003c');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/form') {
      res.end(
        `<!doctype html><form id="f" method="POST" action=${escaped}></form><script>document.getElementById('f').submit();</script>`
      );
      return;
    }
    if (url.pathname === '/fetch') {
      res.end(
        `<!doctype html><script>fetch(${escaped},{method:'POST',mode:'no-cors',credentials:'include'}).finally(function(){window.__done=true;});</script>`
      );
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const listening = await listen(server);
  return { ...listening, seen, aimAt: (value) => void (target = value) };
}
