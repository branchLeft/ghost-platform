import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { verifyClaims } from './tokens.js';
import type { Claims, Verdict, VerifierOptions } from './tokens.js';

/** The digest each RSA algorithm uses. Nothing else is ever verified: there is
 * no entry for `none`, for any HMAC algorithm, or for an elliptic curve. */
const RSA_DIGESTS: Readonly<Record<string, string>> = {
  RS256: 'sha256',
  RS384: 'sha384',
  RS512: 'sha512',
};

const MAX_TOKEN_BYTES = 16 * 1024;
const MIN_RSA_BITS = 2048;
const DEFAULT_MIN_REFETCH_SECONDS = 10;
const DEFAULT_MAX_CACHE_SECONDS = 600;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;

type Json = Record<string, unknown>;

export interface Jwk extends Json {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
}

export interface TokenVerifierOptions extends Omit<VerifierOptions, 'now'> {
  /** The signing algorithms accepted. Defaults to RS256 only, the instance's
   * own; widening it is a decision, not a default. */
  readonly algorithms?: readonly string[];
  /** Returns the instance's published keys. Defaults to the issuer's
   * `/oauth/v2/keys`. A failure is a refusal, never a pass. */
  readonly fetchKeys?: (signal: AbortSignal) => Promise<readonly Jwk[]>;
  /** Seconds since the epoch. */
  readonly clock?: () => number;
  /** A key id never seen before triggers one refetch, at most this often, so
   * an attacker cannot turn unknown ids into a request flood. */
  readonly minRefetchSeconds?: number;
  /** The longest a fetched key set is trusted. Past this age every key is
   * dropped and the set is fetched again, so a key the issuer has withdrawn
   * stops verifying, and a failed fetch leaves no key at all. Defaults to ten
   * minutes; a value that is not a positive number falls back to that. */
  readonly maxCacheSeconds?: number;
  /** The longest a key-set fetch may take before it is abandoned and the token
   * refused. Applies to a supplied `fetchKeys` as well as the default. */
  readonly fetchTimeoutMs?: number;
}

export interface TokenVerifier {
  verify(token: string): Promise<Verdict>;
}

const positiveOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const trimSlash = (url: string): string => (url.endsWith('/') ? url.slice(0, -1) : url);

const deny = (reason: string): Verdict => ({ ok: false, reason });

function decodeSegment(segment: string): Json | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Json)
      : null;
  } catch {
    return null;
  }
}

function rsaKey(jwk: Jwk, algorithm: string): KeyObject | null {
  if (jwk.kty !== 'RSA') return null;
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  if (jwk.alg !== undefined && jwk.alg !== algorithm) return null;
  if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null;
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    return bits >= MIN_RSA_BITS ? key : null;
  } catch {
    return null;
  }
}

/** The one entry point an application calls with a raw bearer token. It
 * checks, in order: shape and size; a pinned signing algorithm; a published key
 * for the token's `kid`; the signature; then the claims. Any failure, including
 * an unreachable key set, is a refusal with a fixed reason that carries no
 * detail from the token. */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const algorithms = options.algorithms ?? ['RS256'];
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const minRefetch = options.minRefetchSeconds ?? DEFAULT_MIN_REFETCH_SECONDS;
  const maxCacheAge = positiveOr(options.maxCacheSeconds, DEFAULT_MAX_CACHE_SECONDS);
  const fetchTimeout = positiveOr(options.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
  const fetchKeys =
    options.fetchKeys ??
    (async (signal: AbortSignal): Promise<readonly Jwk[]> => {
      const response = await fetch(`${trimSlash(options.issuer)}/oauth/v2/keys`, { signal });
      if (!response.ok) throw new Error('key set unavailable');
      const body = (await response.json()) as { keys?: unknown };
      return Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
    });

  let keys: readonly Jwk[] = [];
  let keysAt = Number.NEGATIVE_INFINITY;
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  /** Runs one fetch, abandoned after the timeout whether or not the fetcher
   * honours the abort signal. */
  async function fetchBounded(): Promise<readonly Jwk[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('key set fetch timed out'));
      }, fetchTimeout);
    });
    try {
      return await Promise.race([fetchKeys(controller.signal), expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    attemptedAt = clock();
    const started = attemptedAt;
    inflight = fetchBounded()
      .then((fetched) => {
        keys = fetched;
        keysAt = started;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function keyFor(kid: string): Promise<Jwk | null> {
    const age = clock() - keysAt;
    if (age < 0 || age >= maxCacheAge) keys = [];
    let found = keys.find((key) => key.kid === kid);
    const sinceAttempt = clock() - attemptedAt;
    if (!found && (inflight || sinceAttempt < 0 || sinceAttempt >= minRefetch)) {
      await refresh();
      found = keys.find((key) => key.kid === kid);
    }
    return found ?? null;
  }

  async function check(token: string): Promise<Verdict> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_BYTES) {
      return deny('token is malformed');
    }
    const parts = token.split('.');
    if (parts.length !== 3) return deny('token is malformed');
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

    const header = decodeSegment(headerPart);
    if (!header) return deny('token is malformed');
    const algorithm = header['alg'];
    if (typeof algorithm !== 'string' || !algorithms.includes(algorithm)) {
      return deny('signing algorithm is not accepted');
    }
    const digest = RSA_DIGESTS[algorithm];
    if (digest === undefined) return deny('signing algorithm is not accepted');
    if (header['crit'] !== undefined) return deny('token carries unsupported critical headers');
    const kid = header['kid'];
    if (typeof kid !== 'string' || kid.length === 0) return deny('token names no signing key');

    const jwk = await keyFor(kid);
    if (!jwk) return deny('signing key is not published');
    const key = rsaKey(jwk, algorithm);
    if (!key) return deny('signing key is not usable');

    if (!/^[A-Za-z0-9_-]+$/.test(signaturePart)) return deny('token signature is invalid');
    const signed = Buffer.from(`${headerPart}.${payloadPart}`);
    if (!verify(digest, signed, key, Buffer.from(signaturePart, 'base64url'))) {
      return deny('token signature is invalid');
    }

    const claims = decodeSegment(payloadPart);
    if (!claims) return deny('token is malformed');
    return verifyClaims(claims as Claims, { ...options, now: clock() });
  }

  return {
    async verify(token: string): Promise<Verdict> {
      try {
        return await check(token);
      } catch {
        return deny('token could not be verified');
      }
    },
  };
}
