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
/** Clients each ceiling remembers; past this the oldest is forgotten, never a visitor refused. */
export const CLIENT_TABLE_SIZE = 10_000;

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

/**
 * A per-client limit on the two routes an anonymous visitor can reach: the
 * start of a sign-in and its callback. Two separate ceilings, so a flood of
 * one cannot use up the other's allowance. Each is keyed on the verified
 * client address alone (an IPv6 /64), and when full forgets the oldest client
 * instead of refusing a new one.
 */
export function createClientLimit(options: ClientLimitOptions): ClientLimit {
  const resolver = createSourceResolver(options.trustedProxies);
  const build = (): AttemptCeiling =>
    createAttemptCeiling({
      limit: CLIENT_LIMIT,
      windowMs: CLIENT_WINDOW_MS,
      maxSources: CLIENT_TABLE_SIZE,
      onFull: 'evict-oldest',
    });
  const logins = build();
  const callbacks = build();
  const keyOf = (request: IncomingMessage): string =>
    resolver.resolve(request.socket.remoteAddress, request.headers['x-forwarded-for']) ??
    UNRESOLVED_CLIENT;
  return {
    login: (request, nowMs) => logins.attempt(keyOf(request), nowMs),
    callback: (request, nowMs) => callbacks.attempt(keyOf(request), nowMs),
  };
}
