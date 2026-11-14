import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { PassThrough, pipeline, type Readable } from 'node:stream';
import { admit } from './admit.js';
import { receiveBody, resolveBodyCeiling, type ReceivedBody } from './body.js';
import type {
  AllowedOperation,
  CredentialStore,
  GatewayRequest,
  RefusalCode,
  SignatureVerifier,
} from './contracts.js';
import { createManagedListener, type ListenerOptions, type ManagedListener } from './listener.js';
import { requestContext, type GatewayLog } from './logging.js';
import { refusal, refusalBody } from './refusal.js';
import type { UploadBindings } from './uploads.js';
import type { Upstream, UpstreamAnswer } from './upstream.js';

export interface GatewayServerDeps {
  readonly verifier: SignatureVerifier;
  readonly credentials: CredentialStore;
  readonly upstream: Upstream;
  /** The same table the upstream binds to: admission and the forwarder must share it. */
  readonly uploads: UploadBindings;
  readonly log: GatewayLog;
  readonly spoolDir: string;
  readonly spoolThresholdBytes?: number;
  /**
   * The most body bytes any one request may carry. No body is read before the
   * signature verifies; then the smaller of this and the tenant's own ceiling applies.
   */
  readonly maxBodyBytes: number;
  /** Most authenticated body-bearing requests at once; the next is answered 503 unread. */
  readonly maxConcurrentUploads: number;
  /** The name of a failing check, or undefined when the service can take traffic. */
  readonly readiness: () => Promise<string | undefined>;
  readonly now?: () => number;
  readonly newRequestId?: () => string;
}

const BODY_METHODS: ReadonlySet<string> = new Set(['PUT', 'POST', 'PATCH']);
const XML = { 'content-type': 'application/xml' } as const;
const SIGNED_PREFIX = 'AWS4-HMAC-SHA256 ';

/** What is sent back, and what the request log learns about the request. */
interface Outcome {
  readonly answer: UpstreamAnswer;
  /** The request body was not read to its end, so the connection cannot be reused. */
  readonly closeAfter: boolean;
  readonly keyId?: string;
  readonly operation?: AllowedOperation;
  readonly bytesIn?: number;
}

function refusalAnswer(code: RefusalCode): UpstreamAnswer {
  const r = refusal(code);
  return { status: r.status, headers: XML, body: refusalBody(r), refusal: r };
}

function gatewayRequestOf(req: IncomingMessage, bodySha256: string | undefined): GatewayRequest {
  // Built from the distinct headers: Node's merged `headers` would join a repeated header.
  const headers: Record<string, string | readonly string[]> = {};
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    if (values === undefined || values.length === 0) continue;
    headers[name] = values.length === 1 ? (values[0] as string) : values;
  }
  return {
    method: (req.method ?? '').toUpperCase(),
    rawTarget: req.url ?? '',
    headers,
    ...(bodySha256 === undefined ? {} : { bodySha256 }),
  };
}

/** The body's real digest against the one the signature covered, compared without an early exit. */
function digestMatches(actual: string, declared: string | undefined): boolean {
  if (declared === undefined || declared.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(declared, 'utf8'));
}

/** A request that carries no header-signature at all is turned away before any body is read. */
function carriesSignature(req: IncomingMessage): boolean {
  const values = req.headersDistinct.authorization;
  return values?.length === 1 && (values[0] as string).startsWith(SIGNED_PREFIX);
}

function declaresBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

/** The declared length, NaN when it is not one plain number (which the body stage refuses). */
function declaredLengthOf(req: IncomingMessage): number | undefined {
  if (req.headers['transfer-encoding'] !== undefined) return undefined;
  const values = req.headersDistinct['content-length'];
  if (values === undefined) return undefined;
  const only = values.length === 1 ? (values[0] as string) : '';
  return /^[0-9]{1,15}$/.test(only) ? Number(only) : Number.NaN;
}

/**
 * The request body as a stream the body stage may destroy. Destroying the
 * request itself would close the socket, and the client would see a reset in
 * place of the refusal.
 */
function guardedBody(req: IncomingMessage): Readable {
  const out = new PassThrough();
  req.pipe(out);
  req.once('error', (error) => out.destroy(error));
  req.once('close', () => {
    if (!req.complete) out.destroy(new Error('the request ended early'));
  });
  return out;
}

/** The tenant-facing handler: health and readiness, and the S3 requests. */
export function createGatewayHandler(
  deps: GatewayServerDeps,
  isDraining: () => boolean
): RequestListener {
  const now = deps.now ?? Date.now;
  const newRequestId = deps.newRequestId ?? randomUUID;

  /** Authenticated body-bearing requests being received or forwarded: each may hold a spool file. */
  let uploadsInFlight = 0;

  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal
  ): Promise<Outcome> {
    const method = (req.method ?? '').toUpperCase();
    const refuse = (code: RefusalCode, extra: Partial<Outcome> = {}): Outcome => {
      const answer = refusalAnswer(code);
      return { answer, closeAfter: false, ...extra };
    };

    if (!carriesSignature(req)) {
      const outcome = refuse('signature-refused', { closeAfter: true });
      deps.log.refusal({
        event: 'request-refused',
        code: 'signature-refused',
        status: outcome.answer.status,
        method,
      });
      return outcome;
    }

    const expectsBody = BODY_METHODS.has(method) || declaresBody(req);
    let body: ReceivedBody | undefined;
    let slotTaken = false;
    try {
      // Who signed it is settled before a single body byte is read. The
      // signature covers the digest the client declares for its body; the
      // bytes are checked against that declaration once they have arrived.
      const declared = req.headersDistinct['x-amz-content-sha256'];
      const declaredDigest =
        expectsBody && declared?.length === 1 ? (declared[0] as string) : undefined;
      const request = gatewayRequestOf(req, declaredDigest);
      const admitted = await admit(request, {
        verifier: deps.verifier,
        credentials: deps.credentials,
        logger: deps.log,
        uploads: deps.uploads,
      });
      // A refused request's body is never read, so the connection cannot be reused.
      if (!admitted.ok) return refuse(admitted.refusal.code, { closeAfter: expectsBody });
      const { route, tenant } = admitted;
      const known = { keyId: tenant.keyId, operation: route.operation };

      let forwarded = request;
      let sized: { bytesIn?: number } = {};
      if (expectsBody) {
        const refusedWith = (code: RefusalCode): Outcome => {
          const r = refusal(code);
          deps.log.refusal({
            event: 'request-refused',
            code,
            status: r.status,
            method,
            keyId: tenant.keyId,
            folder: tenant.folder,
            operation: route.operation,
          });
          return refuse(code, { ...known, closeAfter: true });
        };

        let credential;
        try {
          credential = await deps.credentials.lookup(tenant.keyId);
        } catch {
          return refusedWith('internal-error');
        }
        if (credential === undefined) return refusedWith('internal-error');
        const ceiling = resolveBodyCeiling(credential);
        if (!ceiling.ok) return refusedWith(ceiling.refusal.code);
        // The only body cap: the tenant's own ceiling, never more than the configured maximum.
        const capBytes = Math.min(ceiling.bytes, deps.maxBodyBytes);
        const declaredLength = declaredLengthOf(req);
        if (declaredLength !== undefined && declaredLength > capBytes) {
          return refusedWith('body-too-large');
        }
        if (uploadsInFlight >= deps.maxConcurrentUploads) return refusedWith('upstream-throttled');
        uploadsInFlight += 1;
        slotTaken = true;

        // Only now is the client told to send what it holds back.
        if (req.headers.expect?.toLowerCase() === '100-continue') res.writeContinue();
        const received = await receiveBody(guardedBody(req), {
          ceilingBytes: capBytes,
          spoolDir: deps.spoolDir,
          ...(deps.spoolThresholdBytes === undefined
            ? {}
            : { thresholdBytes: deps.spoolThresholdBytes }),
          ...(declaredLength === undefined ? {} : { declaredLength }),
          signal,
          logger: deps.log,
          log: { method, keyId: tenant.keyId, folder: tenant.folder, operation: route.operation },
        });
        if (!received.ok) {
          return {
            answer: refusalAnswer(received.refusal.code),
            closeAfter: true,
            ...known,
          };
        }
        body = received.body;
        sized = { bytesIn: body.size };
        // The bytes must be the ones the signature covered.
        if (!digestMatches(body.sha256, declaredDigest)) {
          const outcome = refuse('signature-refused', { ...known, ...sized });
          deps.log.refusal({
            event: 'request-refused',
            code: 'signature-refused',
            status: outcome.answer.status,
            method,
            keyId: tenant.keyId,
            folder: tenant.folder,
            operation: route.operation,
          });
          return outcome;
        }
        forwarded = { ...request, bodySha256: body.sha256 };
      }

      const answer = await deps.upstream.forward({
        request: forwarded,
        route,
        tenant,
        ...(body === undefined ? {} : { body }),
        signal,
      });
      return { answer, closeAfter: false, ...known, ...sized };
    } catch {
      return refuse('internal-error', { closeAfter: true });
    } finally {
      await body?.dispose().catch(() => undefined);
      if (slotTaken) uploadsInFlight -= 1;
    }
  }

  function send(res: ServerResponse, outcome: Outcome): void {
    const { answer } = outcome;
    res.statusCode = answer.status;
    for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
    if (outcome.closeAfter || isDraining()) res.setHeader('connection', 'close');
    const payload = answer.body;
    if (payload === undefined) {
      res.end();
    } else if (typeof payload === 'string') {
      res.setHeader('content-length', Buffer.byteLength(payload));
      res.end(payload);
    } else {
      pipeline(payload, res, () => undefined);
    }
  }

  async function health(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/healthz') {
      res.statusCode = 200;
      res.end('{"status":"ok"}');
      return;
    }
    const failing = isDraining() ? 'draining' : await deps.readiness().catch(() => 'readiness');
    res.statusCode = failing === undefined ? 200 : 503;
    res.end(
      failing === undefined
        ? '{"status":"ready"}'
        : JSON.stringify({ status: 'not-ready', check: failing })
    );
  }

  return (req, res) => {
    const requestId = newRequestId();
    res.setHeader('x-gateway-request-id', requestId);
    const method = (req.method ?? '').toUpperCase();
    if (
      (req.url === '/healthz' || req.url === '/readyz') &&
      (method === 'GET' || method === 'HEAD')
    ) {
      void health(req, res);
      return;
    }

    const started = now();
    const abort = new AbortController();
    let meta: Outcome | undefined;
    res.once('close', () => {
      if (!res.writableFinished) abort.abort();
      requestContext.run({ requestId }, () => {
        deps.log.request({
          event: 'request',
          method,
          status: res.statusCode,
          durationMs: now() - started,
          ...(meta?.keyId === undefined ? {} : { keyId: meta.keyId }),
          ...(meta?.operation === undefined ? {} : { operation: meta.operation }),
          ...(meta?.bytesIn === undefined ? {} : { bytesIn: meta.bytesIn }),
        });
      });
    });
    requestContext
      .run({ requestId }, async () => {
        const outcome = await serve(req, res, abort.signal);
        meta = outcome;
        send(res, outcome);
      })
      .catch(() => res.destroy());
  };
}

/** The tenant-facing server: the handler above on a listener that can drain. */
export function createGatewayListener(
  deps: GatewayServerDeps,
  options: ListenerOptions
): ManagedListener {
  let managed: ManagedListener | undefined;
  const handler = createGatewayHandler(deps, () => managed?.isDraining() ?? false);
  managed = createManagedListener(handler, options);
  return managed;
}
