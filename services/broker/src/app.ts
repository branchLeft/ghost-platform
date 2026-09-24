import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  validate,
  type SlotName,
  type TenantDescriptor,
  type ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
import type { AdminApiClient } from './adminApi.js';
import { type AuthDeps, verifyRequest } from './auth.js';
import { descriptorHash } from './descriptorHash.js';
import { EMPTY_DRAIN_PAYLOAD, type DrainSource } from './drainSource.js';
import type { DrainFlagStore } from './drainFlag.js';
import type { HealthChecker } from './healthCheck.js';
import { hostOf } from './hostOf.js';
import { clearLeaseAndHash, writeLeaseAndHash, type LeaseStoreConfig } from './leaseStore.js';
import { validateSlotLiteral, type Colour } from './literals.js';
import type { Renderer } from './render.js';
import { readSlotState, writeSlotState, type Phase } from './stateStore.js';
import type { SlotWrapper } from './wrapper.js';
import { writeArtefacts } from './writeArtefacts.js';

const MAX_BODY_BYTES = 256 * 1024;
const FRESH_COLOUR: Colour = 'a';

export interface BrokerDeps {
  readonly auth: AuthDeps;
  readonly slotLiterals: readonly string[];
  readonly zones: ZoneConfig;
  readonly wrapper: SlotWrapper;
  readonly renderer: Renderer;
  readonly adminApi: AdminApiClient;
  readonly drainSource: DrainSource;
  readonly leaseStoreConfig: LeaseStoreConfig;
  readonly drainFlags: DrainFlagStore;
  readonly healthChecker: HealthChecker;
  readonly healthPortBase: number;
  readonly slotDirBase: string;
  readonly stateDir: string;
  readonly drainPollTimeoutMs: number;
  readonly nowMs: () => number;
  readonly log: (line: string) => void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function send(res: ServerResponse, status: number, body?: unknown): void {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['Content-Type'] = 'application/json';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function authHeaders(req: IncomingMessage): {
  timestamp?: string;
  nonce?: string;
  signature?: string;
} {
  const one = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  return {
    timestamp: one(req.headers['x-broker-timestamp']),
    nonce: one(req.headers['x-broker-nonce']),
    signature: one(req.headers['x-broker-signature']),
  };
}

/** Authenticates the request; on failure it has already written the response. Returns the raw body on success. */
async function authenticate(
  deps: BrokerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): Promise<Buffer | null> {
  const rawBody = await readBody(req);
  if (rawBody === null) {
    send(res, 413);
    return null;
  }
  const result = verifyRequest(deps.auth, req.method ?? '', path, authHeaders(req), rawBody);
  if (!result.ok) {
    deps.log(`refused ${req.method} ${path}: ${result.reason}`);
    send(res, 401);
    return null;
  }
  return rawBody;
}

function parseJson(rawBody: Buffer): unknown {
  return JSON.parse(rawBody.toString('utf8'));
}

async function handleReconcile(
  deps: BrokerDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const rawBody = await authenticate(deps, req, res, '/reconcile');
  if (rawBody === null) return;

  let payload: { slot?: unknown; descriptor?: unknown };
  try {
    payload = parseJson(rawBody) as typeof payload;
  } catch {
    return send(res, 400, { error: 'body is not valid JSON' });
  }

  let slot: SlotName;
  try {
    slot = validateSlotLiteral(payload.slot, deps.slotLiterals);
  } catch (err) {
    return send(res, 422, { error: (err as Error).message });
  }

  let descriptor: TenantDescriptor;
  try {
    descriptor = validate(payload.descriptor as TenantDescriptor, deps.zones);
  } catch (err) {
    return send(res, 400, { error: (err as Error).message });
  }
  if (descriptor.kind !== 'demo') {
    return send(res, 400, { error: 'the broker reconciles demo descriptors only' });
  }
  if (descriptor.gate.kind !== 'passphrase') {
    // render-core's own INV-2 already refuses any `kind: "demo"` descriptor
    // whose gate is not `passphrase` inside `validate()` above -- checked
    // directly against a real `validate()` call, not assumed (see
    // app.test.ts's "a demo descriptor must carry a passphrase gate" case
    // history). This branch is unreachable in practice; it exists only so
    // TypeScript narrows `descriptor.gate` to the `passphrase` variant for
    // the plain-string capture below, and it fails loudly rather than
    // reading `undefined` off a union member that should not exist here.
    return send(res, 500, { error: 'a validated demo descriptor had no passphrase gate' });
  }
  // Captured as a plain string rather than read from `descriptor.gate`
  // inside the closure below: TypeScript's narrowing of the `GateSpec`
  // union above does not carry into a nested function.
  const argon2idHash: string = descriptor.gate.argon2idHash;

  const hash = descriptorHash(descriptor);
  const state = await readSlotState(deps.stateDir, slot);

  // Idempotent replay: LLD-2 §04. No side effect runs a second time for an
  // identical (slot, descriptorHash) pair.
  if (state.phase === 'running' && state.descriptorHash === hash) {
    return send(res, 200, { slot, phase: state.phase, colour: state.colour });
  }
  if (state.phase !== 'free') {
    return send(res, 409, { error: `slot "${slot}" is occupied (phase "${state.phase}")` });
  }

  const host = hostOf(descriptor, deps.zones.demoZone);

  async function attempt(): Promise<void> {
    await deps.drainFlags.set(slot, FRESH_COLOUR);
    const artefacts = await deps.renderer.render(descriptor);
    await writeArtefacts(deps.slotDirBase, slot, artefacts);
    await deps.wrapper.start(slot, FRESH_COLOUR);
    await deps.adminApi.configure(`http://127.0.0.1:${descriptor.ports[FRESH_COLOUR]}`, descriptor);
    await writeLeaseAndHash(deps.leaseStoreConfig, host, slot, argon2idHash);
    await deps.drainFlags.clear(slot, FRESH_COLOUR);
  }

  try {
    await attempt();
  } catch (firstErr) {
    deps.log(
      `reconcile failed for slot "${slot}", resetting and retrying once: ${(firstErr as Error).message}`
    );
    await writeSlotState(deps.stateDir, slot, { phase: 'resetting' satisfies Phase });
    try {
      await deps.wrapper.reset(slot);
      await clearLeaseAndHash(deps.leaseStoreConfig, slot);
      await deps.drainFlags.set(slot, 'a');
      await deps.drainFlags.set(slot, 'b');
      await attempt();
    } catch (secondErr) {
      deps.log(`reconcile retry also failed for slot "${slot}": ${(secondErr as Error).message}`);
      await writeSlotState(deps.stateDir, slot, { phase: 'error' satisfies Phase });
      return send(res, 503, { slot, phase: 'error' });
    }
  }

  await writeSlotState(deps.stateDir, slot, {
    phase: 'running' satisfies Phase,
    colour: FRESH_COLOUR,
    descriptorHash: hash,
  });
  send(res, 200, { slot, phase: 'running', colour: FRESH_COLOUR });
}

async function handleReset(
  deps: BrokerDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const rawBody = await authenticate(deps, req, res, '/reset');
  if (rawBody === null) return;

  let payload: { slot?: unknown };
  try {
    payload = parseJson(rawBody) as typeof payload;
  } catch {
    return send(res, 400, { error: 'body is not valid JSON' });
  }
  let slot: SlotName;
  try {
    slot = validateSlotLiteral(payload.slot, deps.slotLiterals);
  } catch (err) {
    return send(res, 422, { error: (err as Error).message });
  }

  await writeSlotState(deps.stateDir, slot, { phase: 'resetting' satisfies Phase });
  try {
    await deps.wrapper.reset(slot);
  } catch (err) {
    deps.log(`reset failed for slot "${slot}": ${(err as Error).message}`);
    await writeSlotState(deps.stateDir, slot, { phase: 'error' satisfies Phase });
    return send(res, 503, { slot, phase: 'error' });
  }
  await clearLeaseAndHash(deps.leaseStoreConfig, slot);
  // A new colour always boots drained (LLD-2 §01b); setting both here means
  // the invariant already holds the instant a next `/reconcile` looks at
  // this slot, rather than depending on `/reconcile` alone to establish it.
  await deps.drainFlags.set(slot, 'a');
  await deps.drainFlags.set(slot, 'b');
  await writeSlotState(deps.stateDir, slot, { phase: 'free' satisfies Phase });
  send(res, 200, { slot, phase: 'free' });
}

async function handleStatus(
  deps: BrokerDeps,
  slotParam: string,
  res: ServerResponse
): Promise<void> {
  let slot: SlotName;
  try {
    slot = validateSlotLiteral(slotParam, deps.slotLiterals);
  } catch {
    return send(res, 404);
  }
  const state = await readSlotState(deps.stateDir, slot);
  const healthy =
    state.phase === 'running' && state.colour !== undefined
      ? await deps.healthChecker.isHealthy(deps.healthPortBase + Number(slot))
      : false;
  send(res, 200, { slot, phase: state.phase, healthy });
}

async function handleDrain(
  deps: BrokerDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const rawBody = await authenticate(deps, req, res, '/drain');
  if (rawBody === null) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.drainPollTimeoutMs);
  try {
    const payload = await deps.drainSource.poll(controller.signal);
    send(res, 200, payload);
  } catch (err) {
    if (controller.signal.aborted) {
      // The long-poll's own deadline, not a source failure: LLD-2 §03 says
      // this endpoint only ever answers, so "nothing arrived in time" is a
      // normal empty response, not an error.
      send(res, 200, EMPTY_DRAIN_PAYLOAD);
      return;
    }
    deps.log(`drain source failed: ${(err as Error).message}`);
    send(res, 502, { error: 'drain source unavailable' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every failure path answers with a non-2xx status and an unexpected throw
 * becomes a 500, matching `services/demo-gate`'s own posture: a caller of
 * this endpoint has nothing useful to do with a response that never came.
 */
export function createBrokerHandler(deps: BrokerDeps): Handler {
  return async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/reconcile' && req.method === 'POST')
        return await handleReconcile(deps, req, res);
      if (path === '/reset' && req.method === 'POST') return await handleReset(deps, req, res);
      if (path === '/drain' && req.method === 'GET') return await handleDrain(deps, req, res);
      const statusMatch = /^\/status\/([^/]+)$/.exec(path);
      if (statusMatch && req.method === 'GET') {
        return await handleStatus(deps, decodeURIComponent(statusMatch[1] ?? ''), res);
      }
      send(res, 404);
    } catch (err) {
      deps.log(`broker error: ${(err as Error).name}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    }
  };
}
