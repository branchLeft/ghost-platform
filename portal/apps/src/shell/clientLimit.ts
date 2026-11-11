import type { IncomingMessage } from 'node:http';
import type { BlockList } from 'node:net';
import {
  createAttemptCeiling,
  createSourceResolver,
  type AttemptCeiling,
} from 'ghost-platform-request-guard/dist/index.js';

/** Requests one client may make to one of the metered routes in a window. */
export const CLIENT_LIMIT = 30;
export const CLIENT_WINDOW_MS = 60_000;
/** Clients each narrow ceiling remembers; past this the oldest is forgotten, never a visitor refused. */
export const CLIENT_TABLE_SIZE = 10_000;
/**
 * Requests one IPv6 /48 may make to one of the metered routes in a window,
 * across all of its /64s: ten times a single client's. A /48 is what an ISP
 * hands one customer, so it holds 65,536 /64s a client can rotate through, each
 * under the narrow limit; this is the ceiling that still stops it.
 */
export const CLIENT_BROAD_LIMIT = 300;
/**
 * /48s each broad ceiling remembers. When it is full of live windows a new /48
 * is refused rather than admitted by forgetting another's count: evicting would
 * let a flood of /48s reset the very counters this tier exists to keep. A /32
 * holds 65,536 /48s, so this is sized to cost an attacker that much to fill.
 */
export const CLIENT_BROAD_TABLE_SIZE = 100_000;

/**
 * The key for a request whose client cannot be told: a trusted proxy that sent
 * no usable `X-Forwarded-For`. No address resolves to this, so it never shares a
 * bucket with a real client, and such requests are metered rather than let by.
 */
export const UNRESOLVED_CLIENT = 'unresolved';

export interface ClientLimitOptions {
  /**
   * The proxies whose `X-Forwarded-For` is believed, and only its rightmost
   * entry. The limiter exists only when this is given: without it the socket
   * peer is the edge itself, and every visitor would share one bucket.
   */
  readonly trustedProxies: BlockList;
}

export type ClientVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface ClientLimit {
  /** Counts one start of a sign-in (`GET /login`) against the request's client. */
  login(request: IncomingMessage, nowMs: number): ClientVerdict;
  /** Counts one callback against the request's client. */
  callback(request: IncomingMessage, nowMs: number): ClientVerdict;
}

/** One route's ceilings: the client's own, and the /48 it sits in. */
interface Tiers {
  readonly narrow: AttemptCeiling;
  readonly broad: AttemptCeiling;
}

/**
 * A per-client limit on the two routes an anonymous visitor can reach: the
 * start of a sign-in and its callback. Two separate sets of ceilings, so a
 * flood of one cannot use up the other's allowance. A request counts against
 * its client's own key (an IPv6 /64, or an IPv4 address) and, for IPv6, against
 * its /48 as well, using the resolver `services/demo-gate` uses. The narrow
 * table forgets its oldest client when full instead of refusing a new one; the
 * broad table refuses a new /48 when full, so a flood of addresses cannot reset
 * a /48's count. An IPv4 client has no broader key, so it is counted once, as
 * before.
 */
export function createClientLimit(options: ClientLimitOptions): ClientLimit {
  const resolver = createSourceResolver(options.trustedProxies);
  const build = (): Tiers => ({
    narrow: createAttemptCeiling({
      limit: CLIENT_LIMIT,
      windowMs: CLIENT_WINDOW_MS,
      maxSources: CLIENT_TABLE_SIZE,
      onFull: 'evict-oldest',
    }),
    broad: createAttemptCeiling({
      limit: CLIENT_BROAD_LIMIT,
      windowMs: CLIENT_WINDOW_MS,
      maxSources: CLIENT_BROAD_TABLE_SIZE,
      onFull: 'refuse',
    }),
  });
  const logins = build();
  const callbacks = build();
  const meter = (tiers: Tiers, request: IncomingMessage, nowMs: number): ClientVerdict => {
    const peer = request.socket.remoteAddress;
    const forwardedFor = request.headers['x-forwarded-for'];
    const key = resolver.resolve(peer, forwardedFor) ?? UNRESOLVED_CLIENT;
    const broadKey = resolver.resolveBroad(peer, forwardedFor);
    // No broader key than the client's own (IPv4, or an unresolved client):
    // a second ceiling on the same key would only repeat the first.
    const broad = broadKey !== null && broadKey !== key ? broadKey : null;
    // Peek both before charging either, so a request one refuses never spends
    // the other's allowance.
    const narrowPeek = tiers.narrow.peek(key, nowMs);
    const broadPeek = broad === null ? { allowed: true as const } : tiers.broad.peek(broad, nowMs);
    if (!narrowPeek.allowed || !broadPeek.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          narrowPeek.allowed ? 0 : narrowPeek.retryAfterSeconds,
          broadPeek.allowed ? 0 : broadPeek.retryAfterSeconds
        ),
      };
    }
    tiers.narrow.attempt(key, nowMs);
    if (broad !== null) tiers.broad.attempt(broad, nowMs);
    return { allowed: true };
  };
  return {
    login: (request, nowMs) => meter(logins, request, nowMs),
    callback: (request, nowMs) => meter(callbacks, request, nowMs),
  };
}
