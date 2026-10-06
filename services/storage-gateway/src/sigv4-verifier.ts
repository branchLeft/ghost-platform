import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  GatewayRequest,
  Refusal,
  SignatureVerifier,
  TenantSecretSource,
  VerifyResult,
} from './contracts.js';

/** Default tolerance between the request's `x-amz-date` and the gateway clock: five minutes. */
export const DEFAULT_CLOCK_WINDOW_MS = 5 * 60 * 1000;

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SCOPE_TERMINATOR = 'aws4_request';

/** Headers every accepted signature must cover. */
export const REQUIRED_SIGNED_HEADERS: readonly string[] = [
  'host',
  'x-amz-content-sha256',
  'x-amz-date',
];

/**
 * Headers that must arrive exactly once. Two `host` or two `x-amz-date`
 * values would let the signer and the upstream disagree about which one
 * counts, so a repeat is refused rather than joined.
 */
const SINGLETON_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'host',
  'x-amz-content-sha256',
  'x-amz-date',
]);

/** Query parameters that mean a presigned (query-authenticated) SigV4 request. */
const PRESIGNED_QUERY_KEYS: ReadonlySet<string> = new Set([
  'x-amz-algorithm',
  'x-amz-credential',
  'x-amz-signature',
  'x-amz-signedheaders',
]);

/** Query parameters that mean a SigV2 query-authenticated request. */
const SIGV2_QUERY_KEYS: ReadonlySet<string> = new Set(['awsaccesskeyid', 'signature']);

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const EMPTY_SHA256 = createHash('sha256').digest('hex');
const BODY_METHODS: ReadonlySet<string> = new Set(['PUT', 'POST', 'PATCH']);
const AMZ_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=([^,\s]+), ?SignedHeaders=([^,\s]+), ?Signature=([0-9a-f]{64})$/;

/** Why a request was refused. Internal detail for tests and logs; never sent to the caller. */
export type SignatureRefusalReason =
  | 'authorization-missing'
  | 'authorization-repeated'
  | 'sigv2'
  | 'presigned'
  | 'algorithm-unsupported'
  | 'authorization-malformed'
  | 'scope-mismatch'
  | 'header-repeated'
  | 'signed-headers-malformed'
  | 'required-header-unsigned'
  | 'signed-header-absent'
  | 'amz-header-unsigned'
  | 'date-malformed'
  | 'clock-skew'
  | 'payload-unsigned'
  | 'payload-streaming'
  | 'payload-hash-malformed'
  | 'body-digest-missing'
  | 'body-digest-mismatch'
  | 'target-malformed'
  | 'key-unknown'
  | 'signature-mismatch'
  | 'internal-failure';

export type DetailedVerifyResult =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly reason: SignatureRefusalReason; readonly refusal: Refusal };

export interface SigV4VerifierOptions {
  /** The region every credential scope must name, for example `nbg1`. */
  readonly region: string;
  /** The service every credential scope must name. Defaults to `s3`. */
  readonly service?: string;
  /** Allowed distance between `x-amz-date` and now, either way. Defaults to {@link DEFAULT_CLOCK_WINDOW_MS}. */
  readonly clockWindowMs?: number;
  /** Supplies each tenant's secret. */
  readonly secrets: TenantSecretSource;
  /** Milliseconds since the epoch; injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const SIGNATURE_REFUSAL: Refusal = {
  code: 'signature-refused',
  message: 'The request signature was not accepted.',
  status: 403,
};

const INTERNAL_ERROR: Refusal = {
  code: 'internal-error',
  message: 'The gateway could not decide this request. Try again.',
  status: 503,
};

class Refused extends Error {
  readonly reason: SignatureRefusalReason;

  constructor(reason: SignatureRefusalReason) {
    super(reason);
    this.reason = reason;
  }
}

function refuse(reason: SignatureRefusalReason): never {
  throw new Refused(reason);
}

/** RFC 3986 encoding as SigV4 defines it: everything but unreserved characters, upper-case hex. */
export function sigv4Escape(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Splits the raw request target into the path, signed as sent, and the raw query. */
export function splitTarget(rawTarget: string): { path: string; query: string } {
  if (!rawTarget.startsWith('/')) refuse('target-malformed');
  const q = rawTarget.indexOf('?');
  return q === -1
    ? { path: rawTarget, query: '' }
    : { path: rawTarget.slice(0, q), query: rawTarget.slice(q + 1) };
}

function decodeComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return refuse('target-malformed');
  }
}

/**
 * Builds the canonical query string from the raw query: each name and value
 * decoded once, re-encoded the SigV4 way, and sorted by name then value. A
 * presigned or SigV2 query is refused here, before any signature work.
 */
export function canonicalQuery(rawQuery: string): string {
  if (rawQuery === '') return '';
  const pairs: [string, string][] = [];
  for (const piece of rawQuery.split('&')) {
    if (piece === '') refuse('target-malformed');
    const eq = piece.indexOf('=');
    const name = decodeComponent(eq === -1 ? piece : piece.slice(0, eq));
    const value = eq === -1 ? '' : decodeComponent(piece.slice(eq + 1));
    const lower = name.toLowerCase();
    if (PRESIGNED_QUERY_KEYS.has(lower)) refuse('presigned');
    if (SIGV2_QUERY_KEYS.has(lower)) refuse('sigv2');
    pairs.push([sigv4Escape(name), sigv4Escape(value)]);
  }
  pairs.sort(([ak, av], [bk, bv]) => (ak === bk ? compare(av, bv) : compare(ak, bk)));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

type HeaderBag = GatewayRequest['headers'];

/** Every present header, lower-cased, with its arrival-order values. */
function collectHeaders(headers: HeaderBag): Map<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    const values = typeof value === 'string' ? [value] : [...value];
    if (values.length === 0) continue;
    out.set(lower, [...(out.get(lower) ?? []), ...values]);
  }
  for (const [name, values] of out) {
    if (values.length > 1 && SINGLETON_HEADERS.has(name)) {
      refuse(name === 'authorization' ? 'authorization-repeated' : 'header-repeated');
    }
  }
  return out;
}

/**
 * The canonical headers block and signed-headers line for the names the
 * signer listed. A repeated header contributes its values in arrival order,
 * each trimmed with inner whitespace collapsed, joined by commas, as SigV4
 * specifies.
 */
export function canonicalHeaders(
  headers: ReadonlyMap<string, readonly string[]>,
  signedHeaders: readonly string[]
): string {
  return signedHeaders
    .map((name) => {
      const values = headers.get(name);
      if (values === undefined) return refuse('signed-header-absent');
      return `${name}:${values.map(canonicalValue).join(',')}\n`;
    })
    .join('');
}

export interface CanonicalRequestParts {
  readonly method: string;
  readonly path: string;
  readonly rawQuery: string;
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly signedHeaders: readonly string[];
  readonly payloadHash: string;
}

/** The SigV4 canonical request. The path is signed exactly as sent, as S3 does. */
export function canonicalRequest(parts: CanonicalRequestParts): string {
  return [
    parts.method,
    parts.path,
    canonicalQuery(parts.rawQuery),
    canonicalHeaders(parts.headers, parts.signedHeaders),
    parts.signedHeaders.join(';'),
    parts.payloadHash,
  ].join('\n');
}

export function stringToSign(amzDate: string, scope: string, canonical: string): string {
  return [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join('\n');
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, SCOPE_TERMINATOR);
}

/** Hex SHA-256 HMAC signature over a string to sign. */
export function signatureHex(key: Buffer, toSign: string): string {
  return createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
}

/** Equal-length hex digests compared without an early exit. */
function digestsEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * The body digest to assume when the body stage supplied none, which it does
 * only for a request with no body. A method that carries a body must always
 * have one, so its absence there is a refusal, not an empty body.
 */
function bodilessDigest(method: string): string {
  if (BODY_METHODS.has(method)) refuse('body-digest-missing');
  return EMPTY_SHA256;
}

function single(headers: ReadonlyMap<string, readonly string[]>, name: string): string | undefined {
  return headers.get(name)?.[0];
}

/** Milliseconds for a basic-format `x-amz-date`; an impossible date such as 31 February is refused. */
function parseAmzDate(value: string | undefined): number {
  const m = value === undefined ? null : AMZ_DATE.exec(value);
  if (m === null) return refuse('date-malformed');
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const roundTrip = new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');
  if (roundTrip !== value) refuse('date-malformed');
  return ms;
}

function checkPayloadHash(headers: ReadonlyMap<string, readonly string[]>): string {
  const declared = single(headers, 'x-amz-content-sha256');
  if (declared === undefined) return refuse('signed-header-absent');
  if (declared === 'UNSIGNED-PAYLOAD') refuse('payload-unsigned');
  if (declared.startsWith('STREAMING-')) refuse('payload-streaming');
  const encoding = (headers.get('content-encoding') ?? []).join(',').toLowerCase();
  if (
    encoding.includes('aws-chunked') ||
    headers.has('x-amz-decoded-content-length') ||
    headers.has('x-amz-trailer')
  ) {
    refuse('payload-streaming');
  }
  if (!HEX_SHA256.test(declared)) refuse('payload-hash-malformed');
  return declared;
}

function parseSignedHeaders(line: string): string[] {
  const names = line.split(';');
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i] as string;
    if (!HEADER_NAME.test(name) || name === 'authorization') refuse('signed-headers-malformed');
    if (i > 0 && compare(names[i - 1] as string, name) >= 0) refuse('signed-headers-malformed');
  }
  for (const required of REQUIRED_SIGNED_HEADERS) {
    if (!names.includes(required)) refuse('required-header-unsigned');
  }
  return names;
}

/**
 * Header-signed SigV4 with a signed payload hash, and nothing else: unsigned,
 * streaming, presigned and SigV2 requests are refused, as are requests dated
 * outside the clock window, scoped to another region or service, or carrying
 * an `x-amz-*` header the signature does not cover.
 */
export class SigV4Verifier implements SignatureVerifier {
  private readonly region: string;
  private readonly service: string;
  private readonly clockWindowMs: number;
  private readonly secrets: TenantSecretSource;
  private readonly now: () => number;

  constructor(options: SigV4VerifierOptions) {
    this.region = options.region;
    this.service = options.service ?? 's3';
    this.clockWindowMs = options.clockWindowMs ?? DEFAULT_CLOCK_WINDOW_MS;
    if (!Number.isFinite(this.clockWindowMs) || this.clockWindowMs < 0) {
      throw new RangeError('clockWindowMs must be a finite, non-negative number');
    }
    this.secrets = options.secrets;
    this.now = options.now ?? Date.now;
  }

  async verify(request: GatewayRequest): Promise<VerifyResult> {
    const result = await this.verifyDetailed(request);
    return result.ok ? result : { ok: false, refusal: result.refusal };
  }

  /** {@link verify}, plus the internal reason for a refusal. */
  async verifyDetailed(request: GatewayRequest): Promise<DetailedVerifyResult> {
    try {
      return await this.check(request);
    } catch (err) {
      if (err instanceof Refused) {
        return { ok: false, reason: err.reason, refusal: SIGNATURE_REFUSAL };
      }
      return { ok: false, reason: 'internal-failure', refusal: INTERNAL_ERROR };
    }
  }

  private async check(request: GatewayRequest): Promise<DetailedVerifyResult> {
    const headers = collectHeaders(request.headers);
    const { path, query } = splitTarget(request.rawTarget);
    // Checked first so a presigned or SigV2 query is named as such, whatever headers it carries.
    canonicalQuery(query);
    const authorization = single(headers, 'authorization');
    if (authorization === undefined) return refuse('authorization-missing');
    if (/^AWS /.test(authorization)) refuse('sigv2');
    if (!authorization.startsWith(`${ALGORITHM} `)) refuse('algorithm-unsupported');
    const m = AUTHORIZATION.exec(authorization);
    if (m === null) return refuse('authorization-malformed');
    const [, credential, signedLine, provided] = m as unknown as [string, string, string, string];

    const scopeParts = credential.split('/');
    if (scopeParts.length !== 5) refuse('authorization-malformed');
    const [keyId, scopeDate, region, service, terminator] = scopeParts as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!KEY_ID.test(keyId)) refuse('authorization-malformed');

    const signedHeaders = parseSignedHeaders(signedLine);
    for (const name of headers.keys()) {
      if (name.startsWith('x-amz-') && !signedHeaders.includes(name)) refuse('amz-header-unsigned');
    }

    const amzDate = single(headers, 'x-amz-date');
    const requestTime = parseAmzDate(amzDate);
    if (
      scopeDate !== (amzDate as string).slice(0, 8) ||
      region !== this.region ||
      service !== this.service ||
      terminator !== SCOPE_TERMINATOR
    ) {
      refuse('scope-mismatch');
    }
    if (Math.abs(this.now() - requestTime) > this.clockWindowMs) refuse('clock-skew');

    const payloadHash = checkPayloadHash(headers);
    const canonical = canonicalRequest({
      method: request.method,
      path,
      rawQuery: query,
      headers,
      signedHeaders,
      payloadHash,
    });

    const secret = await this.secrets.secretFor(keyId);
    if (secret === undefined || secret === '') refuse('key-unknown');
    const scope = `${scopeDate}/${region}/${service}/${SCOPE_TERMINATOR}`;
    const expected = signatureHex(
      signingKey(secret as string, scopeDate, region, service),
      stringToSign(amzDate as string, scope, canonical)
    );
    if (!digestsEqual(expected, provided)) refuse('signature-mismatch');

    const body = request.bodySha256 ?? bodilessDigest(request.method);
    if (!HEX_SHA256.test(body) || !digestsEqual(body, payloadHash)) refuse('body-digest-mismatch');
    return { ok: true, keyId };
  }
}
