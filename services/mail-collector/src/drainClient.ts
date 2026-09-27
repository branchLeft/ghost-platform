import type { DrainTarget } from './descriptorTargets.js';

/** The wire shape GET /drain hands back -- see services/mailgun-shim/src/routes/drain.ts's own WireMessage; this collector is the one caller of that contract. */
export interface WireMessage {
  id: string;
  domain: string;
  emailId: string | null;
  from: string;
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers: Record<string, string>;
  drainCount: number;
}

export interface DrainAck {
  id: string;
  drainCount: number;
}

export interface AckResult {
  acked: string[];
  alreadyHandled: string[];
  unknown: string[];
}

export interface DrainClient {
  /** One GET /drain call against `target`, held open server-side for up to that shim's own holdMs. */
  drain(target: DrainTarget, signal?: AbortSignal): Promise<WireMessage[]>;
  ack(target: DrainTarget, acks: DrainAck[], signal?: AbortSignal): Promise<AckResult>;
}

export interface DrainClientOptions {
  drainToken: string;
  /** Client-side timeout for one GET /drain call -- must exceed the target's own holdMs or every long-poll reads as a failure. */
  drainTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * The collector's only outbound HTTP surface into a drained host: GET
 * /drain and POST /drain/ack, exactly as services/mailgun-shim/src/routes/
 * drain.ts documents them. Never imports that route -- each service here
 * is an independent package, and this client is proven against it by
 * running the real thing (docker-proof/), not by sharing code with it.
 */
export function createDrainClient(opts: DrainClientOptions): DrainClient {
  const doFetch = opts.fetchImpl ?? fetch;

  async function drain(target: DrainTarget, signal?: AbortSignal): Promise<WireMessage[]> {
    const timeout = AbortSignal.timeout(opts.drainTimeoutMs);
    const combined = signal ? anySignal([signal, timeout]) : timeout;
    const res = await doFetch(`${target.baseUrl}/drain`, {
      headers: { Authorization: `Bearer ${opts.drainToken}` },
      signal: combined,
    });
    if (!res.ok) {
      throw new Error(`GET ${target.baseUrl}/drain -> ${res.status}`);
    }
    const body = (await res.json()) as { messages: WireMessage[] };
    return body.messages;
  }

  async function ack(
    target: DrainTarget,
    acks: DrainAck[],
    signal?: AbortSignal
  ): Promise<AckResult> {
    const res = await doFetch(`${target.baseUrl}/drain/ack`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.drainToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ acks }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`POST ${target.baseUrl}/drain/ack -> ${res.status}`);
    }
    return (await res.json()) as AckResult;
  }

  return { drain, ack };
}

/**
 * Node's `AbortSignal.any` exists from v20, but this file's own dependency
 * floor is whatever `@types/node` ships as `^26.0.0` -- a plain fallback
 * costs nothing and keeps this module honest about what it actually needs.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  /* v8 ignore start -- unreachable on this service's pinned Node (.nvmrc:
   * v26.5.0, where AbortSignal.any has existed since v20). Kept as a
   * defensive fallback rather than an assumed invariant, the same choice
   * services/mailgun-shim/src/routes/drain.ts makes for its own narrower
   * body-shape check, in case that pin is ever relaxed. */
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
  /* v8 ignore stop */
}
