/**
 * The state process's onward call: each admitted state request is rebuilt from
 * its routed form, signed with the state upstream key and sent to the state
 * shard under a deadline. It is separate from the media upstream so that the
 * media path keeps its property without exception: nothing in that module can
 * list, copy or delete an object.
 *
 * It re-checks the tenant fence before it lends the key to a request, so a
 * caller that skipped admission cannot borrow it, and it asks the storage
 * service for nothing the routed request does not name.
 */
import type { GatewayRequest, Refusal } from './contracts.js';
import { guardStateTenant, type StateRoutedRequest } from './state-profile.js';
import { sigv4Escape } from './sigv4-verifier.js';
import {
  EMPTY_SHA256,
  UpstreamCredentials,
  XML_HEADERS,
  amzDateOf,
  defaultSleep,
  forwardedHeaders,
  gatewayAnswer,
  guardIdle,
  isThrottle,
  nodeTransport,
  readCapped,
  relayHeaders,
  sanitisedError,
  validateEndpoint,
  type UpstreamAnswer,
  type UpstreamBody,
  type UpstreamLogEntry,
  type UpstreamTransport,
  type UpstreamTransportResponse,
} from './upstream.js';

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export interface StateUpstreamOptions {
  /** The storage service, for example `https://fsn1.example.invalid`. Plain http is accepted for loopback only. */
  readonly endpoint: string | URL;
  readonly region: string;
  /** The state shard's bucket: the one bucket this upstream will ever name. */
  readonly bucket: string;
  readonly credentials: UpstreamCredentials;
  /** Time allowed for the whole call, retries included, until the answer's headers (and any small body) arrive. */
  readonly deadlineMs: number;
  /** Silence allowed in a streamed response body before it is cut. Defaults to the deadline. */
  readonly idleTimeoutMs?: number;
  /** Tries per call when the service asks the gateway to slow down. Defaults to 5. */
  readonly maxAttempts?: number;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly transport?: UpstreamTransport;
  readonly logger?: { upstream(entry: UpstreamLogEntry): void };
}

export interface StateUpstreamInput {
  readonly request: GatewayRequest;
  readonly route: StateRoutedRequest;
  readonly tenant: { readonly keyId: string; readonly folder: string; readonly bucket: string };
  /** Present exactly for `PutObject`. */
  readonly body?: UpstreamBody;
  /** Aborts the upstream call when the client goes away. */
  readonly signal?: AbortSignal;
}

export interface StateUpstream {
  forward(input: StateUpstreamInput): Promise<UpstreamAnswer>;
}

const METHOD_OF: Readonly<Record<StateRoutedRequest['operation'], string>> = {
  GetObject: 'GET',
  HeadObject: 'HEAD',
  PutObject: 'PUT',
  ListObjectsV2: 'GET',
  CopyObject: 'PUT',
  DeleteObject: 'DELETE',
};

/** `/<bucket>/<key>` with each segment escaped the way the signature canonicalises it. */
function objectPath(bucket: string, key: string): string {
  return `/${bucket}/${key.split('/').map(sigv4Escape).join('/')}`;
}

function hasUnsafeSegment(key: string): boolean {
  return key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

/** The listing query, rebuilt from the validated pairs and sorted for the signature. */
function listingQuery(route: StateRoutedRequest): string {
  const pairs = [...(route.listQuery ?? [])].map(
    ([name, value]) => [sigv4Escape(name), sigv4Escape(value)] as const
  );
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

/** True when a route's object keys are safe to put in a URL: no empty, dot or dot-dot segment (a listing prefix is a query value, not a path). */
function routeKeysAreSafe(route: StateRoutedRequest): boolean {
  if (route.key !== undefined && hasUnsafeSegment(route.key)) return false;
  if (route.copySource !== undefined && hasUnsafeSegment(route.copySource.key)) return false;
  return true;
}

export function createStateUpstream(options: StateUpstreamOptions): StateUpstream {
  const endpoint = validateEndpoint(options.endpoint);
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new RangeError('deadlineMs must be a positive, finite number');
  }
  const deadlineMs = options.deadlineMs;
  const idleMs = options.idleTimeoutMs ?? deadlineMs;
  const maxAttempts = options.maxAttempts ?? 5;
  const backoff = options.backoff ?? { baseMs: 100, maxMs: 2000 };
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const transport = options.transport ?? nodeTransport;
  const { credentials, region, bucket } = options;

  async function forward(input: StateUpstreamInput): Promise<UpstreamAnswer> {
    const { request, route, tenant, body } = input;
    const started = now();
    let attempts = 0;
    const log = (outcome: UpstreamLogEntry['outcome'], status?: number): void => {
      options.logger?.upstream({
        event: 'upstream-call',
        outcome,
        operation: route.operation,
        keyId: tenant.keyId,
        ...(status === undefined ? {} : { status }),
        attempts,
        elapsedMs: now() - started,
      });
    };
    const before = (code: Refusal['code'], s3Code: string): UpstreamAnswer => {
      log('refused-before-send');
      return gatewayAnswer(code, s3Code);
    };

    // The signing key is about to be lent to this request: check the tenant
    // fence again here, against the one bucket this upstream serves, so a
    // caller that skipped admission cannot borrow it.
    if (tenant.bucket !== bucket || route.bucket !== bucket) {
      return before('bucket-not-allowed', 'AccessDenied');
    }
    const denied = guardStateTenant(route, {
      profile: 'state',
      folder: tenant.folder,
      bucket: tenant.bucket,
      state: 'active',
      createdAt: '',
    });
    if (denied !== undefined || !routeKeysAreSafe(route)) {
      return before('key-outside-folder', 'AccessDenied');
    }
    const method = METHOD_OF[route.operation];
    const needsBody = route.operation === 'PutObject';
    if (request.method !== method || needsBody !== (body !== undefined)) {
      return before('internal-error', 'ServiceUnavailable');
    }
    // The bytes sent are the bytes whose digest the signature check compared.
    const expectedDigest = request.bodySha256 ?? EMPTY_SHA256;
    const payloadHash = body?.sha256 ?? EMPTY_SHA256;
    if (!HEX_SHA256.test(payloadHash) || payloadHash !== expectedDigest) {
      return before('internal-error', 'ServiceUnavailable');
    }
    const forwarded = forwardedHeaders(request);
    if (forwarded === undefined) return before('target-malformed', 'InvalidURI');
    // The framing and its checksum were this process's to check and are gone from the
    // bytes it sends: the shard gets a plain signed body, and must not be told otherwise.
    forwarded.delete('x-amz-sdk-checksum-algorithm');
    for (const name of [...forwarded.keys()]) {
      if (name.startsWith('x-amz-checksum-')) forwarded.delete(name);
    }
    if (
      forwarded.get('content-encoding')?.some((v) => v.toLowerCase().includes('aws-chunked')) ===
      true
    ) {
      forwarded.delete('content-encoding');
    }
    if (route.operation === 'CopyObject' && route.copySource !== undefined) {
      forwarded.set('x-amz-copy-source', [
        objectPath(route.copySource.bucket, route.copySource.key),
      ]);
    }

    const isListing = route.operation === 'ListObjectsV2';
    const path = isListing ? `/${bucket}` : objectPath(bucket, route.key ?? '');
    const rawQuery = isListing ? listingQuery(route) : '';
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

    const stopped = (): UpstreamAnswer => {
      if (deadlineHit) {
        log('timeout');
        return gatewayAnswer('upstream-timeout', 'RequestTimeout');
      }
      log('client-aborted');
      return gatewayAnswer('upstream-unavailable', 'ServiceUnavailable');
    };

    try {
      for (;;) {
        attempts += 1;
        const headers = new Map<string, string[]>(forwarded);
        if (body !== undefined) headers.set('content-length', [String(body.size)]);
        headers.set('host', [url.host]);
        headers.set('x-amz-content-sha256', [payloadHash]);
        const amzDate = amzDateOf(now());
        headers.set('x-amz-date', [amzDate]);
        const authorization = credentials.authorize({
          method,
          path,
          rawQuery,
          headers,
          payloadHash,
          amzDate,
          region,
        });
        const wire: Record<string, string> = { authorization };
        for (const [name, values] of headers) wire[name] = values.join(',');

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
          if (controller.signal.aborted) return stopped();
          log('unreachable');
          return gatewayAnswer('upstream-unavailable', 'ServiceUnavailable');
        }

        if (isThrottle(response.status)) {
          response.body.resume();
          const ceiling = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (attempts - 1));
          const delay = Math.floor(random() * ceiling);
          if (attempts >= maxAttempts || delay >= deadlineAt - now()) {
            log('throttled', response.status);
            return gatewayAnswer('upstream-throttled', 'SlowDown');
          }
          await sleep(delay, controller.signal);
          if (controller.signal.aborted) return stopped();
          continue;
        }

        const status = response.status;
        // A redirect is never followed: the shard is addressed by its own endpoint.
        if (status >= 300 && status !== 304 && status < 400) {
          response.body.resume();
          log('upstream-error', status);
          return gatewayAnswer('upstream-unavailable', 'ServiceUnavailable');
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

        if (route.operation === 'CopyObject') {
          // A copy can answer 200 with an error document: the object is not made.
          let document: string;
          try {
            document = await readCapped(response.body, controller.signal);
          } catch {
            if (controller.signal.aborted) return stopped();
            log('unreachable');
            return gatewayAnswer('upstream-unavailable', 'ServiceUnavailable');
          }
          if (/<Error[>\s]/.test(document)) {
            log('upstream-error', 500);
            return sanitisedError(500, credentials.redact(document), false);
          }
          log('ok', status);
          return { status, headers: XML_HEADERS, body: document };
        }

        if (method === 'HEAD' || route.operation === 'DeleteObject') {
          response.body.resume();
          log('ok', status);
          return { status, headers: relayHeaders(response.headers, { keepLength: true }) };
        }

        if (route.operation === 'GetObject' || isListing) {
          streaming = true;
          log('ok', status);
          return {
            status,
            headers: relayHeaders(response.headers, { keepLength: true }),
            body: guardIdle(response.body, idleMs),
          };
        }

        // PutObject: nothing in the body is the client's to see.
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
