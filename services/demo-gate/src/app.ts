import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LeaseId, SlotName } from '@branchleft/ghost-platform-render-core';
import { verifyPassphrase, type Argon2idHash } from './argon2id.js';
import type { AttemptCeiling } from './ceiling.js';
import { readGateCookies, setCookieHeader, signCookie, verifyCookie } from './cookie.js';
import { LOGIN_PATH, passphrasePage, safeReturnPath } from './page.js';
import type { GatedHost } from './slots.js';
import type { SourceResolver } from './source.js';

export const VERIFY_PATH = '/__gate/verify';

const MAX_BODY_BYTES = 2048;
const MAX_PASSPHRASE_LENGTH = 256;

export interface GateDeps {
  readonly slots: () => Promise<ReadonlyMap<string, GatedHost>>;
  readonly leaseOf: (slot: SlotName) => Promise<LeaseId>;
  readonly signingKey: Buffer;
  readonly ceiling: AttemptCeiling;
  readonly sources: SourceResolver;
  readonly cookieTtlSeconds: number;
  /**
   * Verified against when the host names no slot or the slot has no lease,
   * so a guess costs the same whether or not there was anything to guess.
   */
  readonly decoyHash: Argon2idHash;
  readonly nowMs: () => number;
  readonly log: (line: string) => void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const COMMON_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
};

const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
};

function send(
  res: ServerResponse,
  status: number,
  body = '',
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { ...COMMON_HEADERS, ...headers });
  res.end(body);
}

function hostOf(req: IncomingMessage): string | null {
  const raw = req.headers.host;
  if (!raw) return null;
  // Drops a port. An IPv6 literal host is not a demo hostname, so it simply
  // fails the lookup that follows.
  return raw.toLowerCase().replace(/:\d+$/, '');
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function currentLease(deps: GateDeps, slot: SlotName): Promise<LeaseId | null> {
  try {
    return await deps.leaseOf(slot);
  } catch {
    return null;
  }
}

async function verify(deps: GateDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const returnPath = safeReturnPath(headerValue(req.headers['x-forwarded-uri']));
  const deny = (): void => send(res, 401, passphrasePage(returnPath, null), PAGE_HEADERS);

  const host = hostOf(req);
  const gated = host === null ? undefined : (await deps.slots()).get(host);
  if (!gated) return deny();

  const nowSeconds = Math.floor(deps.nowMs() / 1000);
  const claims = readGateCookies(req.headers.cookie)
    .map((value) => verifyCookie(deps.signingKey, value, nowSeconds))
    .flatMap((verdict) => (verdict.ok && verdict.claim.slot === gated.slot ? [verdict.claim] : []));
  if (claims.length === 0) return deny();

  // The lease is read on every request and never cached: the instant the
  // broker records a new lease, every cookie issued against the old one
  // stops admitting.
  const lease = await currentLease(deps, gated.slot);
  if (lease === null || !claims.some((claim) => claim.lease === lease)) return deny();

  send(res, 200);
}

async function login(deps: GateDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const source = deps.sources.resolve(req.socket.remoteAddress, req.headers['x-forwarded-for']);
  if (source === null) {
    deps.log('refused a login whose source could not be established');
    return send(res, 403);
  }

  const verdict = deps.ceiling.attempt(source, deps.nowMs());
  if (!verdict.allowed) {
    return send(res, 429, passphrasePage('/', 'DEMO_GATE_TOO_MANY_ATTEMPTS'), {
      ...PAGE_HEADERS,
      'Retry-After': String(verdict.retryAfterSeconds),
    });
  }

  const contentType = headerValue(req.headers['content-type']) ?? '';
  const body =
    contentType.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded'
      ? await readBody(req)
      : null;
  if (body === null) return send(res, 400);
  const form = new URLSearchParams(body);
  const passphrase = form.get('passphrase') ?? '';
  const returnPath = safeReturnPath(form.get('r'));
  if (passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE_LENGTH) {
    return send(res, 400);
  }

  const host = hostOf(req);
  const gated = host === null ? undefined : (await deps.slots()).get(host);
  const lease = gated ? await currentLease(deps, gated.slot) : null;
  // Always exactly one derivation: against the slot's hash when there is a
  // leased slot to admit to, against the decoy otherwise.
  const matched = await verifyPassphrase(
    passphrase,
    gated && lease !== null ? gated.hash : deps.decoyHash
  );

  if (!gated || lease === null || !matched) {
    return send(res, 401, passphrasePage(returnPath, 'DEMO_GATE_WRONG_PASSPHRASE'), PAGE_HEADERS);
  }

  const exp = Math.floor(deps.nowMs() / 1000) + deps.cookieTtlSeconds;
  const cookie = signCookie(deps.signingKey, { slot: gated.slot, lease, exp });
  send(res, 303, '', {
    Location: returnPath,
    'Set-Cookie': setCookieHeader(cookie, deps.cookieTtlSeconds),
  });
}

/**
 * Every failure path answers with a non-2xx status, and an unexpected throw
 * becomes a 500, so the edge's forward_auth -- which admits only on 2xx --
 * denies on any error rather than on a chosen subset of them.
 */
export function createGateHandler(deps: GateDeps): Handler {
  return async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (path === VERIFY_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
        return await verify(deps, req, res);
      }
      if (path === LOGIN_PATH && req.method === 'POST') {
        return await login(deps, req, res);
      }
      send(res, 404);
    } catch (err) {
      deps.log(`gate error: ${(err as Error).name}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    }
  };
}
