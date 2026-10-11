import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

/**
 * The only two callers the admin interface answers. Each holds its own
 * Ed25519 private key; the gateway holds only the two public keys.
 */
export const ADMIN_CALLERS = ['provisioning-controller', 'erasure-job'] as const;
export type AdminCaller = (typeof ADMIN_CALLERS)[number];

export const ADMIN_HEADERS = {
  caller: 'x-gateway-admin-caller',
  timestamp: 'x-gateway-admin-timestamp',
  nonce: 'x-gateway-admin-nonce',
  signature: 'x-gateway-admin-signature',
} as const;

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
// The fixed ASN.1 prefix of an Ed25519 SubjectPublicKeyInfo; only the raw
// 32 key bytes after it vary.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const NONCE_PATTERN = /^[A-Za-z0-9._-]{16,128}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,20}$/;
// Clock drift allowed for a timestamp ahead of ours, and no more: each
// second of forward slack is a second a captured request stays replayable.
const FORWARD_SKEW_SECONDS = 5;
const NONCE_STORE_MAX_ENTRIES = 10_000;

export function isAdminCaller(name: string | undefined): name is AdminCaller {
  return (ADMIN_CALLERS as readonly string[]).includes(name ?? '');
}

/** Imports a raw 32-byte Ed25519 public key. Throws on any other length. */
export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(`an Ed25519 public key is ${ED25519_PUBLIC_KEY_BYTES} raw bytes`);
  }
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/**
 * The bytes a caller signs: its own name, the method, path, timestamp and
 * nonce, then the body. Naming the caller means a signature made for one
 * caller cannot be presented as the other's, and covering the path means a
 * signed state read cannot be replayed as a disable.
 */
export function adminSigningPayload(
  caller: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer
): Buffer {
  return Buffer.concat([
    Buffer.from(`${caller}\n${method}\n${path}\n${timestamp}\n${nonce}\n`, 'utf8'),
    rawBody,
  ]);
}

/**
 * Per-process replay guard: each nonce is accepted once, and remembered
 * until the expiry the caller gives, which is derived from the request's
 * own timestamp so it always outlasts the window that admits the request.
 */
export interface NonceStore {
  claim(nonce: string, nowMs: number, expiresAtMs: number): boolean;
}

/**
 * In-memory, bounded; refuses rather than evicts a live entry once full.
 * Expiries are per request, so not in insertion order: the sweep visits
 * every entry, which the bound keeps cheap.
 */
export function createInMemoryNonceStore(maxEntries = NONCE_STORE_MAX_ENTRIES): NonceStore {
  const seen = new Map<string, number>();
  return {
    claim(nonce, nowMs, expiresAtMs) {
      for (const [key, expiry] of seen) {
        if (expiry <= nowMs) seen.delete(key);
      }
      if (seen.has(nonce) || seen.size >= maxEntries) return false;
      seen.set(nonce, expiresAtMs);
      return true;
    },
  };
}

/**
 * The replay window for a request stamped `requestSeconds`, in
 * milliseconds. A request is admitted from `opensAtMs` until just before
 * `closesAtMs`; its nonce is remembered until `nonceExpiresAtMs`, which is
 * later than `closesAtMs` by the forward skew plus a second, so a nonce can
 * never be forgotten while its request would still be admitted.
 */
export function replayWindow(requestSeconds: number, windowSeconds: number) {
  return {
    opensAtMs: (requestSeconds - FORWARD_SKEW_SECONDS) * 1000,
    closesAtMs: (requestSeconds + windowSeconds + 1) * 1000,
    nonceExpiresAtMs: (requestSeconds + windowSeconds + FORWARD_SKEW_SECONDS + 1) * 1000,
  };
}

export interface AdminAuthDeps {
  /** Exactly one public key per named caller. */
  readonly callerKeys: Readonly<Record<AdminCaller, KeyObject>>;
  readonly replayWindowSeconds: number;
  readonly nonces: NonceStore;
  /** Captured once at start-up: a request signed before it is a replay across a restart. */
  readonly processStartSeconds: number;
  readonly nowMs: () => number;
}

export type AdminAuthResult =
  | { readonly ok: true; readonly caller: AdminCaller }
  | { readonly ok: false; readonly reason: string };

type Headers = Readonly<Record<string, string | undefined>>;

/**
 * Authenticates an admin request as one of the two named callers. Order:
 * the caller name, then format, then the replay window, then the signature
 * against that caller's key alone, and only last the nonce claim, so an
 * unsigned request cannot burn a legitimate caller's nonce.
 */
export function authenticateAdmin(
  deps: AdminAuthDeps,
  method: string,
  path: string,
  headers: Headers,
  rawBody: Buffer
): AdminAuthResult {
  const caller = headers[ADMIN_HEADERS.caller];
  if (!isAdminCaller(caller))
    return { ok: false, reason: 'caller is not one of the named callers' };

  const timestamp = headers[ADMIN_HEADERS.timestamp];
  const nonce = headers[ADMIN_HEADERS.nonce];
  const signature = headers[ADMIN_HEADERS.signature];
  if (timestamp === undefined || !TIMESTAMP_PATTERN.test(timestamp)) {
    return { ok: false, reason: 'missing or malformed timestamp' };
  }
  if (nonce === undefined || !NONCE_PATTERN.test(nonce)) {
    return { ok: false, reason: 'missing or malformed nonce' };
  }
  if (signature === undefined) return { ok: false, reason: 'missing signature' };

  const nowMs = deps.nowMs();
  const requestSeconds = Number(timestamp);
  const window = replayWindow(requestSeconds, deps.replayWindowSeconds);
  if (nowMs < window.opensAtMs || nowMs >= window.closesAtMs) {
    return { ok: false, reason: 'timestamp outside the replay window' };
  }
  // Plus the forward skew: a request stamped ahead of the clock before a
  // restart would otherwise clear the floor once the nonces are forgotten.
  // So a caller must retry, freshly signed, a 401 received within about 6 s
  // of a gateway start: it looks exactly like a wrong key, by design.
  if (requestSeconds <= deps.processStartSeconds + FORWARD_SKEW_SECONDS) {
    return { ok: false, reason: 'timestamp predates this process' };
  }

  const signatureBytes = Buffer.from(signature, 'base64');
  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) {
    return { ok: false, reason: 'signature does not verify' };
  }
  const payload = adminSigningPayload(caller, method, path, timestamp, nonce, rawBody);
  if (!cryptoVerify(null, payload, deps.callerKeys[caller], signatureBytes)) {
    return { ok: false, reason: 'signature does not verify' };
  }

  if (!deps.nonces.claim(nonce, nowMs, window.nonceExpiresAtMs))
    return { ok: false, reason: 'nonce already used' };
  return { ok: true, caller };
}

/** Environment variables holding each caller's raw public key, as base64. */
export const CALLER_KEY_ENV: Readonly<Record<AdminCaller, string>> = {
  'provisioning-controller': 'STORAGE_GATEWAY_ADMIN_KEY_PROVISIONING_CONTROLLER',
  'erasure-job': 'STORAGE_GATEWAY_ADMIN_KEY_ERASURE_JOB',
};

/**
 * Reads both callers' public keys. This reads the process environment, which
 * pins nothing: anything able to set the gateway's environment chooses who
 * may mint. Nothing outside this module calls either loader yet; the start-up
 * code must call only {@link loadPinnedCallerKeys}, with no fallback to this
 * one. Fails closed when either is missing or malformed, or when both are
 * the same key, which would let one caller act as the other.
 */
export function loadCallerKeys(
  env: Readonly<Record<string, string | undefined>>
): Record<AdminCaller, KeyObject> {
  const raw = {} as Record<AdminCaller, Buffer>;
  for (const caller of ADMIN_CALLERS) {
    const name = CALLER_KEY_ENV[caller];
    const value = env[name];
    if (value === undefined || value === '')
      throw new Error(`${name} is not set; refusing to start`);
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== ED25519_PUBLIC_KEY_BYTES || bytes.toString('base64') !== value) {
      throw new Error(`${name} is not a base64 Ed25519 public key`);
    }
    raw[caller] = bytes;
  }
  if (raw['provisioning-controller'].equals(raw['erasure-job'])) {
    throw new Error('the two admin callers must hold different keys');
  }
  return {
    'provisioning-controller': publicKeyFromRaw(raw['provisioning-controller']),
    'erasure-job': publicKeyFromRaw(raw['erasure-job']),
  };
}

export interface PinnedKeysOptions {
  /** The only owner the pinned files may have; root by default. */
  readonly trustedUid?: number;
}

/** Reads a file through one descriptor, refusing one a non-owner could have changed. */
function readTrustedFile(path: string, trustedUid: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.uid !== trustedUid) throw new Error(`${path} is not owned by the trusted user`);
    if ((info.mode & 0o022) !== 0) throw new Error(`${path} is writable by its group or others`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads both callers' public keys from a root-owned file whose SHA-256 is
 * pinned in a second root-owned file, `<path>.sha256`. Each file must be a
 * regular file owned by the trusted user and not writable by group or
 * others, and the keys file must hash to the pinned digest, so editing the
 * keys takes both files. The keys file is JSON with one base64 key per
 * caller name. Fails closed on any mismatch, then applies the same key checks
 * as {@link loadCallerKeys}.
 */
export function loadPinnedCallerKeys(
  path: string,
  options: PinnedKeysOptions = {}
): Record<AdminCaller, KeyObject> {
  const trustedUid = options.trustedUid ?? 0;
  const keysBytes = readTrustedFile(path, trustedUid);
  const pinned = readTrustedFile(`${path}.sha256`, trustedUid).toString('utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(pinned)) throw new Error('the pinned digest is not a SHA-256 hex');
  const actual = createHash('sha256').update(keysBytes).digest();
  if (!timingSafeEqual(actual, Buffer.from(pinned, 'hex'))) {
    throw new Error('the admin keys file does not match its pinned digest; refusing to start');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(keysBytes.toString('utf8'));
  } catch {
    throw new Error('the admin keys file is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the admin keys file must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const env: Record<string, string | undefined> = {};
  for (const caller of ADMIN_CALLERS) {
    const value = record[caller];
    env[CALLER_KEY_ENV[caller]] = typeof value === 'string' ? value : undefined;
  }
  return loadCallerKeys(env);
}
