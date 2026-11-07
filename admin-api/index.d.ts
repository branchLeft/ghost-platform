/**
 * Types for the whole export surface of index.js, hand-written so the package
 * needs no build step. test/types.test.js fails if the names declared here and
 * the names index.js exports ever differ.
 */

/** Ghost's Admin API key: a 24-hex-digit id, a colon, a 64-hex-digit secret. */
export const ADMIN_API_KEY_PATTERN: RegExp;

export function isAdminApiKey(value: string): boolean;

/**
 * A five-minute Admin API token for the key. Throws, without echoing the
 * value, when `key` is not an Admin API key.
 */
export function adminApiToken(key: string, nowSeconds: number): string;

export type AdminApiOutcome = number | 'timeout' | 'network' | 'redirect' | 'bad-response';

/** A request that went wrong. The message is `METHOD /path -> outcome`, nothing else. */
export class AdminApiError extends Error {
  readonly method: string;
  readonly path: string;
  readonly outcome: AdminApiOutcome;
  constructor(method: string, path: string, outcome: AdminApiOutcome);
}

/** The caller asked for something the client refuses before any socket opens. */
export class AdminApiConfigError extends Error {
  constructor(message: string);
}

export interface AdminApiClientOptions {
  /** https on any host, http only on localhost, 127.0.0.1 or [::1]; no userinfo, query or fragment. */
  baseUrl: string;
  /** An Admin API key, `id:secret`. Held in a closure and never exposed. */
  key: string;
  /** One total deadline, send to last body byte. Default 15000. */
  timeoutMs?: number;
  /** Milliseconds, for the token's clock. Default `Date.now`. */
  now?: () => number;
}

export interface AdminApiClient {
  memberCount(): Promise<number>;
  findMemberByEmail(email: string): Promise<Record<string, unknown> | null>;
  listNewsletters(): Promise<unknown[]>;
  getSetting(key: string): Promise<unknown>;
  membersSupportAddress(): Promise<string | null>;
  exportMembersCsv(): Promise<string>;
}

export function createAdminApiClient(options: AdminApiClientOptions): AdminApiClient;
