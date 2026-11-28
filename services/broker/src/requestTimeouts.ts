import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * How long the signed image push (`POST /image`, which the sidecar push uses
 * as well) may go without a single byte arriving before it is refused. It is
 * an idle limit, not a total one: a docker-save tar is gigabytes and crosses
 * a two-hop SSH tunnel, so how long it takes in all is the link's business;
 * a sender that has stopped sending is the broker's.
 */
export const IMAGE_PUSH_IDLE_TIMEOUT_MS = 60_000;

/**
 * The most an image push may take to arrive in all, however steadily it moves.
 * An upper bound for a signed sender, so one stuck or hostile one cannot hold
 * the host's single push slot for ever; generous because the idle clock, not
 * this, is what judges a healthy push.
 */
export const IMAGE_PUSH_MAX_TOTAL_MS = 60 * 60 * 1000;

/**
 * How long a connection may go on being read after the broker has already
 * answered an image push whose body had not finished arriving (a refusal: a
 * bad header, a bad signature, too big). Long enough for the sender to read
 * the answer, short enough that nothing unsigned can hold a connection by
 * dripping into a body nobody wants.
 */
export const REFUSED_PUSH_LINGER_MS = 5_000;

export interface RequestTimeouts {
  /** Every request must send its headers within this long (Node's own `headersTimeout`). */
  readonly headersTimeoutMs: number;
  /** Every route but the image push must be received whole within this long. */
  readonly requestTimeoutMs: number;
  /** The image push may be silent this long; see `IMAGE_PUSH_IDLE_TIMEOUT_MS`. */
  readonly imagePushIdleTimeoutMs?: number;
  /** The image push must be received whole within this long; see `IMAGE_PUSH_MAX_TOTAL_MS`. */
  readonly imagePushMaxTotalMs?: number;
  /** See `REFUSED_PUSH_LINGER_MS`. */
  readonly refusedPushLingerMs?: number;
}

export function isImagePushRequest(req: Pick<IncomingMessage, 'method' | 'url'>): boolean {
  return req.method === 'POST' && (req.url ?? '').split('?')[0] === '/image';
}

function refuseTimedOut(req: IncomingMessage, res: ServerResponse): void {
  // Same answer Node's own `requestTimeout` gives: 408 and the connection closed.
  if (req.complete) return;
  if (!res.headersSent) {
    res.writeHead(408, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('request timed out', () => req.socket.destroy());
  } else {
    req.socket.destroy();
  }
}

/**
 * Node's `requestTimeout` is one clock for the whole request, which cuts off
 * a slow-but-moving multi-gigabyte image push with a 408 the broker never
 * chose. So it is switched off (`0`) and each request is given the clock that
 * fits its route: the image push an idle clock (progress resets it), every
 * other route the old whole-request clock. `headersTimeout` is kept for all.
 */
export function applyRequestTimeouts(server: Server, timeouts: RequestTimeouts): void {
  server.headersTimeout = timeouts.headersTimeoutMs;
  server.requestTimeout = 0;
  const pushIdleMs = timeouts.imagePushIdleTimeoutMs ?? IMAGE_PUSH_IDLE_TIMEOUT_MS;
  const pushMaxTotalMs = timeouts.imagePushMaxTotalMs ?? IMAGE_PUSH_MAX_TOTAL_MS;
  const pushLingerMs = timeouts.refusedPushLingerMs ?? REFUSED_PUSH_LINGER_MS;

  server.prependListener('request', (req: IncomingMessage, res: ServerResponse) => {
    if (req.complete) return; // nothing left to receive: no clock needed

    if (isImagePushRequest(req)) {
      const { socket } = req;
      const onIdle = (): void => refuseTimedOut(req, res);
      // `req.setTimeout`, not the socket's own: with a listener on the request
      // Node leaves the connection to us; without one it destroys it silently.
      req.setTimeout(pushIdleMs, onIdle);
      const totalTimer = setTimeout(onIdle, pushMaxTotalMs);
      totalTimer.unref();
      let lingerTimer: ReturnType<typeof setTimeout> | undefined;
      // Cleared when the request is over (its body is in, or its connection is
      // gone), and NOT when the response is written: a refusal answers while
      // the body is still arriving, and the clocks must outlive that answer.
      // Once the body is in, the broker's own hashing and loading is silent
      // for as long as it takes; that is not the sender's stall.
      const done = (): void => {
        clearTimeout(totalTimer);
        clearTimeout(lingerTimer);
        req.off('timeout', onIdle);
        if (!socket.destroyed) socket.setTimeout(0);
      };
      req.once('end', done);
      req.once('close', done);
      // An answer sent before the body is in is a refusal. The idle clock
      // alone would let a sender drip into it for ever, so it gets a short,
      // hard limit to read the answer and go.
      res.once('finish', () => {
        if (req.complete) return;
        lingerTimer = setTimeout(() => socket.destroy(), pushLingerMs);
        lingerTimer.unref();
      });
      return;
    }

    const timer = setTimeout(() => refuseTimedOut(req, res), timeouts.requestTimeoutMs);
    timer.unref();
    const done = (): void => clearTimeout(timer);
    req.once('end', done);
    res.once('close', done);
  });
}
