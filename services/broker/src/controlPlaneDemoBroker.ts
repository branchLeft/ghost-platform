/**
 * The control plane's signed calls to the demo host's broker, over the
 * tunnel ops1 dials to demo1: reconcile, status, freeze and reset. The demo estate
 * never initiates (LLD-2 section 06): this module only ever sends from ops1,
 * and what it sends is signed with the same scheme `/reconcile` and `/reset`
 * check. It answers with a closed set of replies and never a response body,
 * so nothing a host says can reach a prospect's page. See
 * controlPlaneDemoBroker.md.
 */
import { randomBytes } from 'node:crypto';
import type { SlotName, TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import type { Colour } from './literals.js';
import { signRequest } from './signing.js';

/** What `/reconcile` said, as far as the worker needs it. */
export type ReconcileReply =
  /** 200: the slot is `running` this descriptor, on this colour. */
  | { readonly kind: 'running'; readonly colour: Colour }
  /** 503: the broker's own reset-and-retry-once is spent and the slot is left `error`. */
  | { readonly kind: 'failed' }
  /**
   * 409 with reason `locked`: the broker holds the slot lock for the whole of
   * a reconcile, so an earlier send of this one is still running. Retry later;
   * it is not a refusal.
   */
  | { readonly kind: 'locked' }
  /** Any other answer: the broker refused. A refusal is final and its slot is not ours to touch. */
  | { readonly kind: 'refused'; readonly status: number }
  /** No answer inside the deadline: the request may or may not have run. Sending it again is safe. */
  | { readonly kind: 'unanswered' };

/** What `/reset` said. `locked` (409, reason `locked`) is a reconcile still running: retry later. */
export type ResetReply = 'free' | 'refused' | 'locked' | 'unanswered';

/**
 * What `/freeze` said. Only `detached` means the slot's held evidence is out of
 * the slot and confirmed so: nothing else lets a caller reset.
 * - `detached`: 200, the receipt parsed and names this slot.
 * - `pending`: 503, the revoke or the detach did not complete. The slot stays
 *   held, so every `/reset` is refused; the freeze is sent again.
 * - `locked`: 409 with reason `locked`, a request is already running on the slot.
 * - `nothing-to-freeze`: 409 with reason `nothing-to-freeze`, the slot is free.
 * - `refused`: any other answer, final.
 * - `unanswered`: no answer in the deadline. It may or may not have run, and
 *   sending it again is safe (the broker resumes a freeze it left half done).
 */
export type FreezeReply =
  'detached' | 'pending' | 'locked' | 'nothing-to-freeze' | 'refused' | 'unanswered';

/** `GET /status/{slot}`, reduced to the two facts provisioning is judged on. */
export interface SlotReading {
  readonly phase: string;
  /** The per-colour health answer for the colour now serving. */
  readonly healthy: boolean;
}

export interface DemoBroker {
  reconcile(slot: SlotName, descriptor: TenantDescriptor): Promise<ReconcileReply>;
  /** Undefined when the host did not give a usable answer: unreachable, refused or malformed. */
  status(slot: SlotName): Promise<SlotReading | undefined>;
  reset(slot: SlotName): Promise<ResetReply>;
  /** Moves the slot's evidence out of the slot before a reset; never resets and never destroys. */
  freeze(slot: SlotName): Promise<FreezeReply>;
}

export interface TunnelBrokerOptions {
  /** The local end of the tunnel: loopback, or a private address ops1's containers reach it on. */
  readonly baseUrl: string;
  /** The control plane's Ed25519 signing key, 32 raw bytes. Held here and used for nothing else. */
  readonly privateKeyRaw: Buffer;
  /** Per-call deadline in milliseconds. A reconcile starts a Ghost, so this is generous by default. */
  readonly timeoutMs?: number;
  /** The seams for a test. */
  readonly fetch?: typeof globalThis.fetch;
  readonly nowSeconds?: () => number;
  readonly nonce?: () => string;
}

export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const STATUS_TIMEOUT_MS = 10_000;

const PRIVATE_V4 =
  /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.)\d{1,3}\.\d{1,3}(\.\d{1,3})?$/;

/** Refusing to build is the point: a signing key must never be sent to a name a public resolver answers. */
export class TunnelAddressError extends Error {
  constructor() {
    super('the tunnel address must be an http(s) loopback or private IPv4 address, or localhost');
    this.name = 'TunnelAddressError';
  }
}

function assertTunnelAddress(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TunnelAddressError();
  }
  const host = url.hostname;
  const local = host === 'localhost' || host === '[::1]' || PRIVATE_V4.test(host);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !local) {
    throw new TunnelAddressError();
  }
  return baseUrl.replace(/\/+$/, '');
}

function isColour(value: unknown): value is Colour {
  return value === 'a' || value === 'b';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A 409 whose machine-readable reason is `reason`: never the prose beside it. */
function isConflict(status: number, body: unknown, reason: string): boolean {
  return status === 409 && isRecord(body) && body['reason'] === reason;
}

/** A 409 the broker marked `locked`: the machine-readable reason, never the prose beside it. */
function isLockedConflict(status: number, body: unknown): boolean {
  return status === 409 && isRecord(body) && body['reason'] === 'locked';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function createTunnelBroker(options: TunnelBrokerOptions): DemoBroker {
  const baseUrl = assertTunnelAddress(options.baseUrl);
  const send = options.fetch ?? globalThis.fetch;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const newNonce = options.nonce ?? (() => randomBytes(16).toString('hex'));
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  /** One signed POST. A fresh nonce every call, so a resend is never taken for a replay. Never throws. */
  async function signedPost(path: string, payload: unknown): Promise<Response | undefined> {
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    const timestamp = String(nowSeconds());
    const nonce = newNonce();
    const signature = signRequest(options.privateKeyRaw, 'POST', path, timestamp, nonce, rawBody);
    try {
      return await send(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Broker-Timestamp': timestamp,
          'X-Broker-Nonce': nonce,
          'X-Broker-Signature': signature,
        },
        body: rawBody,
        // A 3xx would turn the signed POST into something else: it is a refusal.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return undefined;
    }
  }

  return {
    async reconcile(slot, descriptor) {
      const response = await signedPost('/reconcile', { slot, descriptor });
      if (response === undefined) return { kind: 'unanswered' };
      const body = await readJson(response);
      if (response.status === 200) {
        if (isRecord(body) && body['phase'] === 'running' && isColour(body['colour'])) {
          return { kind: 'running', colour: body['colour'] };
        }
        // A 200 that is not the documented answer is not a success.
        return { kind: 'refused', status: 200 };
      }
      if (response.status === 503 && isRecord(body) && body['phase'] === 'error') {
        return { kind: 'failed' };
      }
      if (isLockedConflict(response.status, body)) return { kind: 'locked' };
      return { kind: 'refused', status: response.status };
    },

    async reset(slot) {
      const response = await signedPost('/reset', { slot });
      if (response === undefined) return 'unanswered';
      if (response.status === 200) return 'free';
      return isLockedConflict(response.status, await readJson(response)) ? 'locked' : 'refused';
    },

    async freeze(slot) {
      const response = await signedPost('/freeze', { slot });
      if (response === undefined) return 'unanswered';
      const body = await readJson(response);
      if (response.status === 200) {
        // Detached is the broker's confirmed marker, not any 200.
        return isRecord(body) && body['evidence'] === 'detached' && body['slot'] === slot
          ? 'detached'
          : 'refused';
      }
      if (response.status === 503) {
        return isRecord(body) && body['evidence'] === 'frozen' ? 'pending' : 'refused';
      }
      if (isConflict(response.status, body, 'locked')) return 'locked';
      if (isConflict(response.status, body, 'nothing-to-freeze')) return 'nothing-to-freeze';
      return 'refused';
    },

    async status(slot) {
      let response: Response;
      try {
        response = await send(`${baseUrl}/status/${encodeURIComponent(slot)}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(Math.min(timeoutMs, STATUS_TIMEOUT_MS)),
        });
      } catch {
        return undefined;
      }
      if (response.status !== 200) return undefined;
      const body = await readJson(response);
      if (
        !isRecord(body) ||
        typeof body['phase'] !== 'string' ||
        typeof body['healthy'] !== 'boolean'
      ) {
        return undefined;
      }
      return { phase: body['phase'], healthy: body['healthy'] };
    },
  };
}
