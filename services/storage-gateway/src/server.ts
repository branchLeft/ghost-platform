import { randomUUID } from 'node:crypto';
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
  /** The most body bytes read before the client is known: the largest ceiling any tenant may hold. */
  readonly maxBodyBytes: number;
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

  async function serve(req: IncomingMessage, signal: AbortSignal): Promise<Outcome> {
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

    let body: ReceivedBody | undefined;
    try {
      if (BODY_METHODS.has(method) || declaresBody(req)) {
        const declared = declaredLengthOf(req);
        const received = await receiveBody(guardedBody(req), {
          ceilingBytes: deps.maxBodyBytes,
          spoolDir: deps.spoolDir,
          ...(deps.spoolThresholdBytes === undefined
            ? {}
            : { thresholdBytes: deps.spoolThresholdBytes }),
          ...(declared === undefined ? {} : { declaredLength: declared }),
          signal,
          logger: deps.log,
          log: { method },
        });
        if (!received.ok) {
          return {
            answer: refusalAnswer(received.refusal.code),
            closeAfter: true,
          };
        }
        body = received.body;
      }

      const request = gatewayRequestOf(req, body?.sha256);
      const admitted = await admit(request, {
        verifier: deps.verifier,
        credentials: deps.credentials,
        logger: deps.log,
        uploads: deps.uploads,
      });
      if (!admitted.ok) return refuse(admitted.refusal.code, { closeAfter: false });
      const { route, tenant } = admitted;
      const known = { keyId: tenant.keyId, operation: route.operation };
      const sized = body === undefined ? {} : { bytesIn: body.size };

      if (body !== undefined) {
        // The cap that applies to this tenant is known only now that the signature has verified.
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
          return refuse(code, { ...known, ...sized });
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
        if (body.size > ceiling.bytes) return refusedWith('body-too-large');
      }

      const answer = await deps.upstream.forward({
        request,
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
        const outcome = await serve(req, abort.signal);
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
