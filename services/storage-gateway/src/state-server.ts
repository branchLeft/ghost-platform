/**
 * The state process's tenant-facing handler: health and readiness, and a
 * tenant's Pulumi state requests. It is the media handler's order of checks
 * with the state profile's admission and upstream in place of the media ones:
 * who signed it, whether the credential is a state credential, whether the
 * request stays inside its prefix, whether the signature is fresh, whether the
 * tenant is within its rate, then the body, then the shard.
 *
 * It shares no listener, no upstream key and no code path that could forward
 * a media request: a media credential presented here is refused at admission.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import { receiveBody, type ReceivedBody } from './body.js';
import type { RefusalCode } from './contracts.js';
import type { StateLimits } from './limits/state.js';
import { createManagedListener, type ListenerOptions, type ManagedListener } from './listener.js';
import { requestContext, type GatewayLog } from './logging.js';
import { refusal } from './refusal.js';
import type { ReplayGuard } from './replay.js';
import {
  BODY_METHODS,
  carriesSignature,
  declaredLengthOf,
  declaresBody,
  digestMatches,
  gatewayRequestOf,
  guardedBody,
  refusalAnswer,
} from './server.js';
import { requestIdentity } from './sigv4-verifier.js';
import { admitState, type StateOperation } from './state-profile.js';
import type { StateUpstream } from './state-upstream.js';
import type { CredentialStore, SignatureVerifier } from './contracts.js';
import type { UpstreamAnswer } from './upstream.js';

export interface StateServerDeps {
  readonly verifier: SignatureVerifier;
  readonly credentials: CredentialStore;
  readonly upstream: StateUpstream;
  readonly log: GatewayLog;
  readonly spoolDir: string;
  readonly spoolThresholdBytes?: number;
  /** The one body cap every state credential shares: an order of magnitude above the largest checkpoint. */
  readonly maxBodyBytes: number;
  /** Most body-bearing requests being received or forwarded at once; the next is answered unread. */
  readonly maxConcurrentWrites: number;
  /** Most of those one credential may hold at once. Never more than the total. */
  readonly maxConcurrentWritesPerTenant: number;
  readonly replay: ReplayGuard;
  readonly limits: StateLimits;
  readonly readiness: () => Promise<string | undefined>;
  readonly now?: () => number;
  readonly newRequestId?: () => string;
}

interface ReplayHold {
  signature?: string;
}

interface StateOutcome {
  readonly answer: UpstreamAnswer;
  readonly closeAfter: boolean;
  readonly keyId?: string;
  readonly operation?: StateOperation;
  readonly bytesIn?: number;
}

/** The tenant-facing handler of the state process. */
export function createStateHandler(
  deps: StateServerDeps,
  isDraining: () => boolean
): RequestListener {
  const now = deps.now ?? Date.now;
  const newRequestId = deps.newRequestId ?? randomUUID;

  let writesInFlight = 0;
  const writesByTenant = new Map<string, number>();

  function isRetryable(outcome: StateOutcome): boolean {
    return outcome.answer.status >= 500 || outcome.answer.refusal?.code === 'body-incomplete';
  }

  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    signal: AbortSignal,
    hold: ReplayHold
  ): Promise<StateOutcome> {
    const method = (req.method ?? '').toUpperCase();
    const refuse = (code: RefusalCode, extra: Partial<StateOutcome> = {}): StateOutcome => ({
      answer: refusalAnswer(code),
      closeAfter: false,
      ...extra,
    });

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
    let slotFolder: string | undefined;
    try {
      const declared = req.headersDistinct['x-amz-content-sha256'];
      const declaredDigest =
        expectsBody && declared?.length === 1 ? (declared[0] as string) : undefined;
      const request = gatewayRequestOf(req, declaredDigest);
      const admitted = await admitState(request, {
        verifier: deps.verifier,
        credentials: deps.credentials,
        logger: deps.log,
      });
      // A refused request's body is never read, so the connection cannot be reused.
      if (!admitted.ok) return refuse(admitted.refusal.code, { closeAfter: expectsBody });
      const { route, tenant } = admitted;
      const known = { keyId: tenant.keyId, operation: route.operation };
      const logRefusal = (code: RefusalCode, reason?: string): void => {
        const r = refusal(code);
        deps.log.refusal({
          event: 'request-refused',
          code,
          status: r.status,
          method,
          keyId: tenant.keyId,
          folder: tenant.folder,
          operation: route.operation,
          ...(reason === undefined ? {} : { reason }),
        });
      };

      // Only a request that verified gets here, so an unsigned or forged one
      // can neither burn a signature nor fill the guard.
      const identity = requestIdentity(request);
      const claim =
        identity === undefined
          ? 'unreadable'
          : deps.replay.claim(identity.signature, identity.requestTimeMs, now());
      if (identity === undefined || claim !== 'claimed') {
        const code = claim === 'replayed' ? 'signature-refused' : 'internal-error';
        logRefusal(code, claim);
        return refuse(code, { ...known, closeAfter: expectsBody });
      }
      hold.signature = identity.signature;

      let decision: ReturnType<StateLimits['check']>;
      try {
        decision = deps.limits.check({ keyId: tenant.keyId, operation: route.operation });
      } catch {
        decision = { ok: false, refusal: refusal('internal-error') };
      }
      if (!decision.ok) {
        logRefusal(decision.refusal.code);
        return refuse(decision.refusal.code, { ...known, closeAfter: expectsBody });
      }

      let forwarded = request;
      let sized: { bytesIn?: number } = {};
      const refusedWith = (code: RefusalCode): StateOutcome => {
        logRefusal(code);
        return refuse(code, { ...known, closeAfter: true });
      };
      // Only a write of an object carries a body: a copy, a read, a listing or a
      // delete that declares one is not what Pulumi sends, and its bytes are never read.
      if (route.operation !== 'PutObject' && declaresBody(req)) {
        return refusedWith('operation-not-allowed');
      }
      if (route.operation === 'PutObject') {
        const declaredLength = declaredLengthOf(req);
        if (declaredLength !== undefined && declaredLength > deps.maxBodyBytes) {
          return refusedWith('body-too-large');
        }
        // Checked and taken with no await between, or two requests could both pass.
        if ((writesByTenant.get(tenant.folder) ?? 0) >= deps.maxConcurrentWritesPerTenant) {
          return refusedWith('tenant-upload-limit');
        }
        if (writesInFlight >= deps.maxConcurrentWrites) return refusedWith('upstream-throttled');
        writesInFlight += 1;
        writesByTenant.set(tenant.folder, (writesByTenant.get(tenant.folder) ?? 0) + 1);
        slotTaken = true;
        slotFolder = tenant.folder;

        if (req.headers.expect?.toLowerCase() === '100-continue') res.writeContinue();
        const received = await receiveBody(guardedBody(req), {
          ceilingBytes: deps.maxBodyBytes,
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
          logRefusal('signature-refused');
          return refuse('signature-refused', { ...known, ...sized });
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
      if (slotTaken) writesInFlight -= 1;
      if (slotFolder !== undefined) {
        const left = (writesByTenant.get(slotFolder) ?? 1) - 1;
        if (left > 0) writesByTenant.set(slotFolder, left);
        else writesByTenant.delete(slotFolder);
      }
    }
  }

  function send(res: ServerResponse, outcome: StateOutcome): void {
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
    let meta: StateOutcome | undefined;
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
        const hold: ReplayHold = {};
        const outcome = await serve(req, res, abort.signal, hold);
        if (hold.signature !== undefined && isRetryable(outcome))
          deps.replay.release(hold.signature);
        meta = outcome;
        send(res, outcome);
      })
      .catch(() => res.destroy());
  };
}

/** The state process's tenant-facing server: the handler above on a listener that can drain. */
export function createStateListener(
  deps: StateServerDeps,
  options: ListenerOptions
): ManagedListener {
  let managed: ManagedListener | undefined;
  const handler = createStateHandler(deps, () => managed?.isDraining() ?? false);
  managed = createManagedListener(handler, options);
  return managed;
}
