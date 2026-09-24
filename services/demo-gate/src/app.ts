import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { verifyPassphrase, type Argon2idHash } from './argon2id.js';
import type { AttemptCeiling } from './ceiling.js';
import { readGateCookies, setCookieHeader, signCookie, verifyCookie } from './cookie.js';
import { DerivationGateFullError, type DerivationGate } from './derivationGate.js';
import { LOGIN_PATH, passphrasePage, safeReturnPath } from './page.js';
import type { CurrentLease, GatedHost } from './slots.js';
import type { SourceResolver } from './source.js';

export const VERIFY_PATH = '/__gate/verify';

const MAX_BODY_BYTES = 2048;
const MAX_PASSPHRASE_LENGTH = 256;

export interface GateDeps {
  readonly slots: () => Promise<ReadonlyMap<string, GatedHost>>;
  readonly leaseOf: (slot: SlotName) => Promise<CurrentLease>;
  readonly signingKey: Buffer;
  /** Per source, keyed narrow (IPv6 /64, or the IPv4 address). */
  readonly ceiling: AttemptCeiling;
  /**
   * Per source, keyed broad (IPv6 /48, an aggregate over many /64s a single
   * customer is routinely allocated; the same key as `ceiling` on IPv4,
   * where there is no cheaper broader tier). Checked and incremented
   * alongside `ceiling` as a second, independent limit -- never a
   * replacement for it -- so a flood spread across many /64s inside one
   * /48 still exhausts a bucket, not just an uncounted multiplication of
   * them.
   */
  readonly broadCeiling: AttemptCeiling;
  /**
   * Caps derivations in flight at once, across every source together --
   * the per-source ceilings above bound one source's rate, not how many
   * distinct sources can be mid-derivation at the same time.
   */
  readonly derivationGate: DerivationGate;
  readonly sources: SourceResolver;
  readonly cookieTtlSeconds: number;
  /**
   * Verified against when the host names no slot, the slot has no lease, or
   * the lease's `hashId` does not name the hash actually in hand, so a
   * guess costs the same whether or not there was anything real to guess.
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

async function currentLease(deps: GateDeps, slot: SlotName): Promise<CurrentLease | null> {
  try {
    return await deps.leaseOf(slot);
  } catch {
    return null;
  }
}

/**
 * The hash `login()` derives against: the slot's real hash only when
 * `tied` (the lease record's `hashId` matches it), the decoy in every
 * other case -- an unknown host, no lease, or an untied pair, including
 * mid-recycle. Exported and pure so a test can assert the selection
 * directly, rather than only the eventual HTTP status, which looks
 * identical whether the decoy was actually derived against or the
 * derivation was skipped outright.
 */
export function selectVerificationHash(
  gated: GatedHost | undefined,
  tied: boolean,
  decoyHash: Argon2idHash
): Argon2idHash {
  return tied && gated !== undefined ? gated.hash : decoyHash;
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
  const current = await currentLease(deps, gated.slot);
  if (current === null || !claims.some((claim) => claim.lease === current.lease)) return deny();

  send(res, 200);
}

async function login(deps: GateDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const source = deps.sources.resolve(req.socket.remoteAddress, req.headers['x-forwarded-for']);
  const broadSource = deps.sources.resolveBroad(
    req.socket.remoteAddress,
    req.headers['x-forwarded-for']
  );
  if (source === null || broadSource === null) {
    deps.log('refused a login whose source could not be established');
    return send(res, 403);
  }

  const attemptedAt = deps.nowMs();
  // Peeked, not charged: a request either tier would refuse must cost
  // neither one anything, and must not create a new /64 entry in the
  // narrow table just because the /48 tier was going to refuse it anyway
  // -- checking without charging first is what stops that. Only once both
  // agree to admit is the attempt actually recorded, on both together.
  const narrowPeek = deps.ceiling.peek(source, attemptedAt);
  const broadPeek = deps.broadCeiling.peek(broadSource, attemptedAt);
  if (!narrowPeek.allowed || !broadPeek.allowed) {
    const retryAfterSeconds = Math.max(
      narrowPeek.allowed ? 0 : narrowPeek.retryAfterSeconds,
      broadPeek.allowed ? 0 : broadPeek.retryAfterSeconds
    );
    return send(res, 429, passphrasePage('/', 'DEMO_GATE_TOO_MANY_ATTEMPTS'), {
      ...PAGE_HEADERS,
      'Retry-After': String(retryAfterSeconds),
    });
  }
  deps.ceiling.attempt(source, attemptedAt);
  deps.broadCeiling.attempt(broadSource, attemptedAt);

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
  const current = gated ? await currentLease(deps, gated.slot) : null;
  // The slots file (the hash) and a slot's lease record are two files the
  // broker writes independently, at different moments, with no shared
  // transaction between the two writes. Reading them a moment apart can
  // therefore surface a hash and a lease from two different tenancies --
  // the recycle race render-core/src/lease.ts's contract exists to close.
  // `hashId` is how a lease record ties itself to the one hash the broker
  // wrote it alongside; admitting only when the two agree is correct
  // regardless of which file the broker happens to write first, or how
  // these two reads land relative to either write -- unlike trusting a
  // read order, which only holds if the broker's write order does too.
  const tied = gated !== undefined && current !== null && current.hashId === gated.hashId;

  // Always exactly one derivation: against the slot's hash when the lease
  // just read is tied to it, against the decoy otherwise -- an untied pair
  // is refused the same as no lease at all, never derived against, and its
  // timing must not tell the two cases apart. Routed through the
  // derivation gate so a flood of distinct sources -- none of which trips
  // its own per-source ceiling -- cannot pile up unbounded concurrent
  // derivations; past the gate's own queue, refused rather than deriving.
  const hashToVerify = selectVerificationHash(gated, tied, deps.decoyHash);
  let matched: boolean;
  try {
    matched = await deps.derivationGate.run(() => verifyPassphrase(passphrase, hashToVerify));
  } catch (err) {
    if (err instanceof DerivationGateFullError) {
      // Not the visitor's fault: the gate ran out of capacity, not them out
      // of guesses. The attempt already recorded above is given back
      // rather than left to count against a ceiling it never really used.
      deps.ceiling.refund(source);
      deps.broadCeiling.refund(broadSource);
      return send(res, 503, '', { 'Retry-After': '1' });
    }
    throw err;
  }

  if (gated === undefined || current === null || !tied || !matched) {
    return send(res, 401, passphrasePage(returnPath, 'DEMO_GATE_WRONG_PASSPHRASE'), PAGE_HEADERS);
  }

  const exp = Math.floor(deps.nowMs() / 1000) + deps.cookieTtlSeconds;
  const cookie = signCookie(deps.signingKey, { slot: gated.slot, lease: current.lease, exp });
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
