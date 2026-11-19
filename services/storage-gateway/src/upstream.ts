import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { inspect } from 'node:util';
import { pipeline, type Readable } from 'node:stream';
import type { GatewayRequest, Refusal, RefusalCode } from './contracts.js';
import { refusal, s3ErrorBody } from './refusal.js';
import type { RoutedRequest } from './router.js';
import {
  canonicalRequest,
  sigv4Escape,
  signatureHex,
  signingKey,
  stringToSign,
} from './sigv4-verifier.js';
import type { UploadBindings } from './uploads.js';

export const EMPTY_SHA256 = createHash('sha256').digest('hex');
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const REDACTED = '[redacted]';
/** The most of an upstream error or control response the gateway will read into memory. */
const MAX_BUFFERED_BYTES = 64 * 1024;
const SIGNED_HEADERS_OF = /SignedHeaders=([^,\s]+)/;
const SAFE_HEADER_VALUE = /^[\x20-\x7e]*$/;
const SAFE_S3_CODE = /^[A-Za-z0-9]{1,64}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * Request headers that may reach the storage service, and only when the
 * client's own signature covered them. Anything else the client signed is
 * dropped, because the gateway re-signs what it forwards and must not lend
 * its key to a header the tenant chose.
 */
const FORWARDED_HEADER: RegExp =
  /^(?:content-type|content-md5|cache-control|content-disposition|content-encoding|content-language|expires|range|if-match|if-none-match|if-modified-since|if-unmodified-since|x-amz-sdk-checksum-algorithm|x-amz-checksum-[a-z0-9]+)$/;

/** Signed headers the gateway replaces or discards: they describe the hop, the tenant or the client. */
const GATEWAY_OWNED_HEADER: ReadonlySet<string> = new Set([
  'host',
  'authorization',
  'content-length',
  'x-amz-date',
  'x-amz-content-sha256',
  'x-amz-security-token',
  'user-agent',
  'x-amz-user-agent',
  'amz-sdk-invocation-id',
  'amz-sdk-request',
  'accept-encoding',
  'connection',
  'expect',
]);

/**
 * Object metadata the gateway writes on every `PutObject`: the SHA-256 of the
 * bytes it sent. A later existence check reads it back to tell whether an
 * upload whose answer never arrived committed these exact bytes.
 */
const DIGEST_METADATA = 'x-amz-meta-gateway-sha256';
const DEFAULT_CONFIRM_CAP_MS = 15_000;
const DEFAULT_CONFIRM_INTERVAL_MS = 1000;
/** The headers of a confirmed upload's answer: what the service would have sent for the PUT. */
const CONFIRMED_HEADER: ReadonlySet<string> = new Set(['etag', 'x-amz-version-id']);

const RESPONSE_HEADER: RegExp =
  /^(?:content-type|content-length|content-range|accept-ranges|etag|last-modified|cache-control|content-disposition|content-encoding|content-language|expires|x-amz-version-id|x-amz-request-id|x-amz-checksum-[a-z0-9]+)$/;

/**
 * The gateway's own key for the storage service. The secret is held in a
 * private field and every route to printing it is closed: JSON, inspect and
 * string conversion all give the redaction marker.
 */
export class UpstreamCredentials {
  readonly #keyId: string;
  readonly #secret: string;

  constructor(keyId: string, secret: string) {
    if (keyId === '' || secret === '') throw new RangeError('upstream credentials are empty');
    this.#keyId = keyId;
    this.#secret = secret;
  }

  /** The `Authorization` header for a request over the given canonical parts. */
  authorize(parts: {
    readonly method: string;
    readonly path: string;
    readonly rawQuery: string;
    readonly headers: ReadonlyMap<string, readonly string[]>;
    readonly payloadHash: string;
    readonly amzDate: string;
    readonly region: string;
  }): string {
    const signedHeaders = [...parts.headers.keys()].sort();
    const date = parts.amzDate.slice(0, 8);
    const scope = `${date}/${parts.region}/s3/aws4_request`;
    const canonical = canonicalRequest({
      method: parts.method,
      path: parts.path,
      rawQuery: parts.rawQuery,
      headers: parts.headers,
      signedHeaders,
      payloadHash: parts.payloadHash,
    });
    const signature = signatureHex(
      signingKey(this.#secret, date, parts.region, 's3'),
      stringToSign(parts.amzDate, scope, canonical)
    );
    return (
      `AWS4-HMAC-SHA256 Credential=${this.#keyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`
    );
  }

  /** The text with the key id and secret replaced, for anything that might be logged or shown. */
  redact(text: string): string {
    return text.split(this.#secret).join(REDACTED).split(this.#keyId).join(REDACTED);
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/** The body stage's result: bytes already hashed, readable again for each attempt. */
export interface UpstreamBody {
  /** Lower-case hex SHA-256 of exactly the bytes {@link open} yields. */
  readonly sha256: string;
  readonly size: number;
  open(): Readable;
}

export interface UpstreamTransportRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Readable;
  readonly signal: AbortSignal;
}

export interface UpstreamTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: Readable;
}

export type UpstreamTransport = (
  request: UpstreamTransportRequest
) => Promise<UpstreamTransportResponse>;

export interface UpstreamLogEntry {
  readonly event: 'upstream-call';
  readonly outcome:
    | 'ok'
    | 'upstream-error'
    | 'timeout'
    | 'throttled'
    | 'unreachable'
    | 'client-aborted'
    | 'refused-before-send'
    | 'committed-unanswered';
  readonly operation: string;
  /** The tenant's key id, never the gateway's own. */
  readonly keyId: string;
  readonly status?: number;
  readonly attempts: number;
  /** Existence checks made to learn whether an unanswered upload committed. */
  readonly probes?: number;
  readonly elapsedMs: number;
}

export interface UpstreamOptions {
  /** The storage service, for example `https://nbg1.example.invalid`. Plain http is accepted for loopback only. */
  readonly endpoint: string | URL;
  readonly region: string;
  readonly credentials: UpstreamCredentials;
  /** Time allowed for the whole call, retries included, until the answer's headers (and any small body) arrive. */
  readonly deadlineMs: number;
  /** Silence allowed in a streamed response body before it is cut. Defaults to the deadline. */
  readonly idleTimeoutMs?: number;
  /**
   * Time allowed, after a `PutObject` the service took but never answered, to
   * learn whether it committed before the gateway answers a failure. Defaults
   * to the deadline, capped at 15 seconds.
   */
  readonly confirmWindowMs?: number;
  /** Pause between existence checks inside that window. Defaults to 1 second. */
  readonly confirmIntervalMs?: number;
  /** Tries per call when the service asks the gateway to slow down. Defaults to 5. */
  readonly maxAttempts?: number;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  /** Uniform in [0, 1); injectable for tests. */
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly transport?: UpstreamTransport;
  /** Bound on a multipart create and released on complete or abort. Absent, no binding is kept. */
  readonly uploads?: UploadBindings;
  readonly logger?: { upstream(entry: UpstreamLogEntry): void };
}

export interface UpstreamInput {
  readonly request: GatewayRequest;
  readonly route: RoutedRequest;
  readonly tenant: { readonly keyId: string; readonly folder: string; readonly bucket: string };
  /** Present exactly for the operations that carry a body. */
  readonly body?: UpstreamBody;
  /** Aborts the upstream call when the client goes away. */
  readonly signal?: AbortSignal;
}

export interface UpstreamAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** A stream for a relayed object body; a string for a gateway-written or sanitised document; absent when empty. */
  readonly body?: Readable | string;
  /** Set when the gateway, not the storage service, produced the answer. */
  readonly refusal?: Refusal;
}

export interface Upstream {
  forward(input: UpstreamInput): Promise<UpstreamAnswer>;
}

const BODY_OPERATIONS: ReadonlySet<string> = new Set([
  'PutObject',
  'UploadPart',
  'CreateMultipartUpload',
  'CompleteMultipartUpload',
]);

export const XML_HEADERS = { 'content-type': 'application/xml' } as const;

export function gatewayAnswer(code: RefusalCode, s3Code: string): UpstreamAnswer {
  const r = refusal(code);
  return {
    status: r.status,
    headers: XML_HEADERS,
    body: s3ErrorBody(s3Code, r.message),
    refusal: r,
  };
}

const timeoutAnswer = (): UpstreamAnswer => gatewayAnswer('upstream-timeout', 'RequestTimeout');
const throttledAnswer = (): UpstreamAnswer => gatewayAnswer('upstream-throttled', 'SlowDown');
const unavailableAnswer = (): UpstreamAnswer =>
  gatewayAnswer('upstream-unavailable', 'ServiceUnavailable');
const internalAnswer = (): UpstreamAnswer => gatewayAnswer('internal-error', 'ServiceUnavailable');

function refusedAnswer(code: RefusalCode, s3Code: string): UpstreamAnswer {
  return gatewayAnswer(code, s3Code);
}

export function amzDateOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');
}

export function validateEndpoint(endpoint: string | URL): URL {
  const url = new URL(endpoint.toString());
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new RangeError('the upstream endpoint must be https, or http on loopback');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new RangeError('the upstream endpoint must be a bare origin');
  }
  if (url.pathname !== '/') throw new RangeError('the upstream endpoint must be a bare origin');
  return url;
}

/**
 * The headers to forward: those the client's signature covered and the
 * allowlist admits. `undefined` when a value cannot be forwarded verbatim.
 */
export function forwardedHeaders(request: GatewayRequest): Map<string, string[]> | undefined {
  const out = new Map<string, string[]>();
  const auth = request.headers.authorization;
  const authorization = typeof auth === 'string' ? auth : undefined;
  const signed = new Set((SIGNED_HEADERS_OF.exec(authorization ?? '')?.[1] ?? '').split(';'));
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined || GATEWAY_OWNED_HEADER.has(name)) continue;
    if (!signed.has(name) || !FORWARDED_HEADER.test(name)) continue;
    const values = typeof value === 'string' ? [value] : [...value];
    if (values.length === 0) continue;
    if (!values.every((v) => SAFE_HEADER_VALUE.test(v))) return undefined;
    out.set(name, [...(out.get(name) ?? []), ...values]);
  }
  return out;
}

/** The upstream query, rebuilt from the routed request and never from the client's target. */
function upstreamQuery(route: RoutedRequest): string {
  const parts: [string, string][] = [];
  if (route.operation === 'CreateMultipartUpload') parts.push(['uploads', '']);
  if (route.partNumber !== undefined) parts.push(['partNumber', String(route.partNumber)]);
  if (route.uploadId !== undefined) parts.push(['uploadId', route.uploadId]);
  return parts.map(([k, v]) => `${sigv4Escape(k)}=${sigv4Escape(v)}`).join('&');
}

const METHOD_OF: Readonly<Record<string, string>> = {
  PutObject: 'PUT',
  UploadPart: 'PUT',
  CreateMultipartUpload: 'POST',
  CompleteMultipartUpload: 'POST',
  AbortMultipartUpload: 'DELETE',
  GetObject: 'GET',
  HeadObject: 'HEAD',
};

export function isThrottle(status: number): boolean {
  return status === 429 || status === 503;
}

/** Reads at most the cap of a small response; the rest is discarded. */
export async function readCapped(stream: Readable, signal: AbortSignal): Promise<string> {
  const onAbort = (): void => {
    stream.destroy();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      if (total < MAX_BUFFERED_BYTES) chunks.push(buf.subarray(0, MAX_BUFFERED_BYTES - total));
      total += buf.length;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function relayHeaders(
  raw: UpstreamTransportResponse['headers'],
  options: { readonly keepLength: boolean }
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    const first = typeof value === 'string' ? value : value?.[0];
    if (first === undefined || !RESPONSE_HEADER.test(lower) || !SAFE_HEADER_VALUE.test(first)) {
      continue;
    }
    if (lower === 'content-length' && !options.keepLength) continue;
    out[lower] = first;
  }
  return out;
}

/** An upstream error reduced to its S3 code under a fixed message: nothing the service echoed survives. */
export function sanitisedError(status: number, document: string, head: boolean): UpstreamAnswer {
  if (head) return { status, headers: {} };
  const code = /<Code>([^<]*)<\/Code>/.exec(document)?.[1] ?? '';
  const s3Code = SAFE_S3_CODE.test(code) ? code : status >= 500 ? 'InternalError' : 'AccessDenied';
  return {
    status,
    headers: XML_HEADERS,
    body: s3ErrorBody(s3Code, 'The storage service returned an error.'),
  };
}

/** Cuts a streamed body that goes quiet, so a stalled read cannot hold the connection forever. */
export function guardIdle(stream: Readable, idleMs: number): Readable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      stream.destroy(new Error('the storage service stopped sending'));
    }, idleMs);
  };
  arm();
  stream.on('data', arm);
  stream.once('close', () => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return stream;
}

/** The transport used outside tests: node's own client, one request per call, no redirects followed. */
export const nodeTransport: UpstreamTransport = (req) =>
  new Promise((resolve, reject) => {
    const send = req.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const clientRequest = send(
      req.url,
      { method: req.method, headers: { ...req.headers }, signal: req.signal },
      (res: IncomingMessage) => {
        resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res });
      }
    );
    clientRequest.once('error', reject);
    if (req.body === undefined) {
      clientRequest.end();
    } else {
      pipeline(req.body, clientRequest, (err) => {
        if (err) reject(err);
      });
    }
  });

export const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * The gateway's onward call. Each allowed request is rebuilt from its routed
 * form, re-signed with the gateway's one real key and sent under a deadline,
 * so the client always gets an answer. Hetzner's slow-down answers are
 * retried with jittered backoff inside that same deadline.
 */
export function createUpstream(options: UpstreamOptions): Upstream {
  const endpoint = validateEndpoint(options.endpoint);
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new RangeError('deadlineMs must be a positive, finite number');
  }
  const deadlineMs = options.deadlineMs;
  const idleMs = options.idleTimeoutMs ?? deadlineMs;
  const confirmWindowMs = options.confirmWindowMs ?? Math.min(deadlineMs, DEFAULT_CONFIRM_CAP_MS);
  const confirmIntervalMs = options.confirmIntervalMs ?? DEFAULT_CONFIRM_INTERVAL_MS;
  for (const [name, value] of [
    ['confirmWindowMs', confirmWindowMs],
    ['confirmIntervalMs', confirmIntervalMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive, finite number`);
    }
  }
  const maxAttempts = options.maxAttempts ?? 5;
  const backoff = options.backoff ?? { baseMs: 100, maxMs: 2000 };
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const transport = options.transport ?? nodeTransport;
  const { credentials, region, uploads } = options;

  async function forward(input: UpstreamInput): Promise<UpstreamAnswer> {
    const { request, route, tenant, body } = input;
    const started = now();
    let attempts = 0;
    let probes = 0;
    const log = (outcome: UpstreamLogEntry['outcome'], status?: number): void => {
      options.logger?.upstream({
        event: 'upstream-call',
        outcome,
        operation: route.operation,
        keyId: tenant.keyId,
        ...(status === undefined ? {} : { status }),
        attempts,
        ...(probes === 0 ? {} : { probes }),
        elapsedMs: now() - started,
      });
    };
    const before = (answer: UpstreamAnswer): UpstreamAnswer => {
      log('refused-before-send');
      return answer;
    };

    // The signing key is about to be lent to this request: re-check the tenant
    // fence here as well, so a caller that skipped admission cannot borrow it.
    // A dot or empty segment survives escaping and is collapsed by URL parsing,
    // which would move the request out of the folder the prefix test just checked.
    if (
      route.bucket !== tenant.bucket ||
      !route.key.startsWith(`${tenant.folder}/`) ||
      route.key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      return before(refusedAnswer('key-outside-folder', 'AccessDenied'));
    }
    const method = METHOD_OF[route.operation];
    const needsBody = BODY_OPERATIONS.has(route.operation);
    if (method === undefined || request.method !== method || needsBody !== (body !== undefined)) {
      return before(internalAnswer());
    }
    // The bytes sent are the bytes whose digest the signature check compared.
    const expectedDigest = request.bodySha256 ?? EMPTY_SHA256;
    const payloadHash = body?.sha256 ?? EMPTY_SHA256;
    if (!HEX_SHA256.test(payloadHash) || payloadHash !== expectedDigest) {
      return before(internalAnswer());
    }
    const forwarded = forwardedHeaders(request);
    if (forwarded === undefined) return before(refusedAnswer('target-malformed', 'InvalidURI'));

    const path = `/${tenant.bucket}/${route.key.split('/').map(sigv4Escape).join('/')}`;
    const rawQuery = upstreamQuery(route);
    const url = new URL(`${path}${rawQuery === '' ? '' : `?${rawQuery}`}`, endpoint);

    const controller = new AbortController();
    const clientAbort = (): void => controller.abort();
    input.signal?.addEventListener('abort', clientAbort, { once: true });
    if (input.signal?.aborted === true) controller.abort();
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      controller.abort();
    }, deadlineMs);
    const deadlineAt = started + deadlineMs;
    let streaming = false;

    /** The wire headers for one signed call to the object's path. */
    const signedWire = (
      callMethod: string,
      callQuery: string,
      base: ReadonlyMap<string, readonly string[]>,
      hash: string
    ): Record<string, string> => {
      const headers = new Map<string, readonly string[]>(base);
      headers.set('host', [url.host]);
      headers.set('x-amz-content-sha256', [hash]);
      const amzDate = amzDateOf(now());
      headers.set('x-amz-date', [amzDate]);
      const authorization = credentials.authorize({
        method: callMethod,
        path,
        rawQuery: callQuery,
        headers,
        payloadHash: hash,
        amzDate,
        region,
      });
      const wire: Record<string, string> = { authorization };
      for (const [name, values] of headers) wire[name] = values.join(',');
      return wire;
    };

    /**
     * After a `PutObject` the service took but never answered: the service may
     * have committed it and lost only the acknowledgement (branchLeft's lab
     * measured exactly that). Answering a failure then makes the client write
     * the object again, or tells a person an upload failed that succeeded. So
     * check the key, inside a window of its own, for the digest this upload
     * wrote. A match is the success the service never sent; anything else
     * leaves the failure standing.
     */
    async function confirmCommitted(): Promise<UpstreamAnswer | undefined> {
      if (route.operation !== 'PutObject' || input.signal?.aborted === true) return undefined;
      const window = new AbortController();
      const closeWindow = (): void => window.abort();
      const windowTimer = setTimeout(closeWindow, confirmWindowMs);
      input.signal?.addEventListener('abort', closeWindow, { once: true });
      try {
        while (!window.signal.aborted) {
          probes += 1;
          let response: UpstreamTransportResponse;
          try {
            response = await transport({
              method: 'HEAD',
              url: new URL(path, endpoint),
              headers: signedWire('HEAD', '', new Map(), EMPTY_SHA256),
              signal: window.signal,
            });
          } catch {
            // Out of time, or the service cannot be reached: nothing more to learn.
            return undefined;
          }
          response.body.resume();
          const raw = response.headers[DIGEST_METADATA];
          const digest = typeof raw === 'string' ? raw : raw?.[0];
          if (response.status === 200 && digest === payloadHash) {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(
              relayHeaders(response.headers, { keepLength: false })
            )) {
              if (CONFIRMED_HEADER.has(name)) headers[name] = value;
            }
            log('committed-unanswered', 200);
            return { status: 200, headers };
          }
          // Not there yet, or another write's bytes: the commit may still land.
          await sleep(confirmIntervalMs, window.signal);
        }
        return undefined;
      } finally {
        clearTimeout(windowTimer);
        input.signal?.removeEventListener('abort', closeWindow);
      }
    }

    const stopped = (): UpstreamAnswer => {
      if (deadlineHit) {
        log('timeout');
        return timeoutAnswer();
      }
      log('client-aborted');
      return unavailableAnswer();
    };

    function finishControl(document: string, upstreamStatus: number): UpstreamAnswer {
      // A complete can answer 200 with an error document: the object is not made.
      if (/<Error[>\s]/.test(document)) {
        log('upstream-error', 500);
        return sanitisedError(500, credentials.redact(document), false);
      }
      if (route.operation === 'CreateMultipartUpload') {
        const id = /<UploadId>([^<]{1,1024})<\/UploadId>/.exec(document)?.[1];
        const bound =
          id !== undefined &&
          (uploads === undefined ||
            uploads.bind(decodeEntities(id), {
              keyId: tenant.keyId,
              bucket: tenant.bucket,
              key: route.key,
            }));
        if (!bound) {
          log('upstream-error', upstreamStatus);
          return unavailableAnswer();
        }
      } else if (route.uploadId !== undefined) {
        uploads?.release(route.uploadId);
      }
      log('ok', upstreamStatus);
      return { status: upstreamStatus, headers: XML_HEADERS, body: document };
    }

    try {
      for (;;) {
        attempts += 1;
        const headers = new Map<string, string[]>(forwarded);
        if (body !== undefined) headers.set('content-length', [String(body.size)]);
        if (route.operation === 'PutObject') headers.set(DIGEST_METADATA, [payloadHash]);
        const wire = signedWire(method, rawQuery, headers, payloadHash);

        let response: UpstreamTransportResponse;
        try {
          response = await transport({
            method,
            url,
            headers: wire,
            ...(body === undefined ? {} : { body: body.open() }),
            signal: controller.signal,
          });
        } catch {
          // Unanswered is not unwritten: a deadline or a dropped connection
          // can follow a commit, so learn which before answering a failure.
          const timedOut = deadlineHit;
          if (controller.signal.aborted && !timedOut) return stopped();
          const committed = await confirmCommitted();
          if (committed !== undefined) return committed;
          if (timedOut) return stopped();
          log('unreachable');
          return unavailableAnswer();
        }

        if (isThrottle(response.status)) {
          response.body.resume();
          const ceiling = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (attempts - 1));
          const delay = Math.floor(random() * ceiling);
          if (attempts >= maxAttempts || delay >= deadlineAt - now()) {
            log('throttled', response.status);
            return throttledAnswer();
          }
          await sleep(delay, controller.signal);
          if (controller.signal.aborted) return stopped();
          continue;
        }

        const status = response.status;
        if (status >= 300 && status !== 304 && status < 400) {
          response.body.resume();
          log('upstream-error', status);
          return unavailableAnswer();
        }

        if (status >= 400) {
          let document = '';
          try {
            document = await readCapped(response.body, controller.signal);
          } catch {
            if (controller.signal.aborted) return stopped();
          }
          log('upstream-error', status);
          return sanitisedError(status, credentials.redact(document), method === 'HEAD');
        }

        if (
          route.operation === 'CreateMultipartUpload' ||
          route.operation === 'CompleteMultipartUpload'
        ) {
          let document: string;
          try {
            document = await readCapped(response.body, controller.signal);
          } catch {
            if (controller.signal.aborted) return stopped();
            log('unreachable');
            return unavailableAnswer();
          }
          return finishControl(document, status);
        }

        if (method === 'HEAD' || route.operation === 'AbortMultipartUpload') {
          response.body.resume();
          if (route.operation === 'AbortMultipartUpload' && route.uploadId !== undefined) {
            uploads?.release(route.uploadId);
          }
          log('ok', status);
          return { status, headers: relayHeaders(response.headers, { keepLength: true }) };
        }

        if (route.operation === 'GetObject') {
          streaming = true;
          log('ok', status);
          return {
            status,
            headers: relayHeaders(response.headers, { keepLength: true }),
            body: guardIdle(response.body, idleMs),
          };
        }

        // PutObject and UploadPart: nothing in the body is the client's to see.
        response.body.resume();
        log('ok', status);
        return { status, headers: relayHeaders(response.headers, { keepLength: false }) };
      }
    } finally {
      // A streamed body outlives this call: the idle guard bounds it, and the
      // client's abort must still reach the upstream request.
      clearTimeout(timer);
      if (!streaming) input.signal?.removeEventListener('abort', clientAbort);
    }
  }

  return { forward };
}
