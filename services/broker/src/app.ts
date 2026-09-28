import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hashIdOf,
  validate,
  type HashId,
  type SlotName,
  type TenantDescriptor,
  type ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
import type { AdminApiClient } from './adminApi.js';
import { type AuthDeps, verifyRequest } from './auth.js';
import { descriptorHash } from './descriptorHash.js';
import { EMPTY_DRAIN_PAYLOAD, type DrainSource } from './drainSource.js';
import type { DrainFlagStore } from './drainFlag.js';
import type { GhostReadinessChecker } from './ghostReadiness.js';
import { waitUntilReady } from './ghostReadiness.js';
import type { HealthChecker } from './healthCheck.js';
import { hostOf } from './hostOf.js';
import { clearLeaseAndHash, writeLeaseAndHash, type LeaseStoreConfig } from './leaseStore.js';
import { otherColour, validateSlotLiteral, type Colour } from './literals.js';
import type { Renderer } from './render.js';
import { type SlotLock } from './slotLock.js';
import { slotAllocation, slotPort } from './slotPorts.js';
import { HostConflictError, hostHeldByAnotherSlot, hostOfSlotEntry } from './slotsFile.js';
import {
  assertHashRotated,
  readSlotState,
  writeSlotState,
  UnrotatedHashError,
  type Phase,
  type SlotState,
} from './stateStore.js';
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
  readonly ghostReadiness: GhostReadinessChecker;
  /** How long a swap waits for a freshly started colour to answer 200 before giving up on it. */
  readonly ghostReadyPollTimeoutMs: number;
  readonly healthPortBase: number;
  readonly appPortBase: number;
  readonly uidBase: number;
  readonly slotDirBase: string;
  readonly stateDir: string;
  readonly slotLock: SlotLock;
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
  const newHashId = hashIdOf(argon2idHash);
  const hash = descriptorHash(descriptor);
  const host = hostOf(descriptor, deps.zones.demoZone);

  // Refuse a descriptor whose ports or uid disagree with this slot's own
  // allocation, before anything below touches the renderer or the Admin
  // API. LLD-2 §01 is load-bearing on "no port to pick, no uid to compute"
  // -- `slotPort` already keeps the Admin API call itself slot-derived, but
  // the renderer still receives whatever `ports`/`uid` the caller sent,
  // unchanged (render-core reads them straight off the descriptor rather
  // than recomputing them). A mismatch here is malformed input for *this*
  // slot, not a state conflict, so it is a 400 like the other
  // descriptor-shape refusals above, not a 409.
  const allocation = slotAllocation(deps.uidBase, deps.appPortBase, deps.healthPortBase, slot);
  if (
    descriptor.uid !== allocation.uid ||
    descriptor.ports.a !== allocation.ports.a ||
    descriptor.ports.b !== allocation.ports.b ||
    descriptor.ports.health !== allocation.ports.health
  ) {
    return send(res, 400, {
      error: `descriptor's uid/ports don't match slot "${slot}"'s own allocation`,
    });
  }

  // LLD-2 §04's `preparing` phase, restored: nothing below this point runs
  // for this slot without holding its lock, so a `/reset` (or a second
  // `/reconcile`) racing this one sees an occupied slot for the whole
  // attempt, not only after it finishes.
  if (!deps.slotLock.claim(slot)) {
    return send(res, 409, { error: `slot "${slot}" is locked by a concurrent request` });
  }
  try {
    const state = await readSlotState(deps.stateDir, slot);

    // Idempotent replay: LLD-2 §04. No side effect runs a second time for
    // an identical (slot, descriptorHash) pair.
    if (state.phase === 'running' && state.descriptorHash === hash) {
      return send(res, 200, { slot, phase: state.phase, colour: state.colour });
    }
    // A new descriptor for a slot that is already `running` a different
    // one moves the tenancy to the other colour rather than refusing it --
    // the whole reason a slot reserves a colour pair at all. Every other
    // non-`free` phase (`preparing`, `resetting`,
    // `detaching`, `error`) still refuses below: none of them has a
    // `colour` this reconcile could safely deploy alongside.
    if (state.phase === 'running' && state.colour !== undefined) {
      return await attemptColourSwap(
        deps,
        res,
        slot,
        state,
        descriptor,
        host,
        argon2idHash,
        hash,
        newHashId
      );
    }
    if (state.phase !== 'free') {
      return send(res, 409, { error: `slot "${slot}" is occupied (phase "${state.phase}")` });
    }
    try {
      assertHashRotated(state, newHashId, slot);
    } catch (err) {
      if (!(err instanceof UnrotatedHashError)) throw err;
      return send(res, 409, { error: err.message });
    }
    const heldBy = await hostHeldByAnotherSlot(deps.leaseStoreConfig.slotsPath, host, slot);
    if (heldBy !== null) {
      return send(res, 409, { error: `host "${host}" is already held by slot "${heldBy}"` });
    }

    await writeSlotState(deps.stateDir, slot, {
      phase: 'preparing' satisfies Phase,
      lastHashId: state.lastHashId,
    });

    async function attempt(): Promise<void> {
      await deps.drainFlags.set(slot, FRESH_COLOUR);
      const artefacts = await deps.renderer.render(descriptor);
      await writeArtefacts(deps.slotDirBase, slot, artefacts);
      await deps.wrapper.start(slot, FRESH_COLOUR);
      // The slot's own fixed port, never the descriptor's (LLD-2 §01,
      // load-bearing: "no port to pick"). See slotPorts.ts.
      const port = slotPort(deps.appPortBase, slot, FRESH_COLOUR);
      await deps.adminApi.configure(`http://127.0.0.1:${port}`, descriptor);
      await writeLeaseAndHash(deps.leaseStoreConfig, host, slot, argon2idHash);
      await deps.drainFlags.clear(slot, FRESH_COLOUR);
    }

    try {
      await attempt();
    } catch (firstErr) {
      if (firstErr instanceof HostConflictError) {
        // The atomic backstop inside upsertSlotEntry, not the pre-check
        // above: another slot won the same host in the narrow window
        // between that check and this write. Retrying cannot help (the
        // conflict persists), so this tears down what `attempt()` already
        // started and refuses outright, rather than spending the one
        // automatic retry on something that cannot succeed.
        deps.log(`reconcile refused for slot "${slot}": ${firstErr.message}`);
        await writeSlotState(deps.stateDir, slot, {
          phase: 'resetting' satisfies Phase,
          lastHashId: state.lastHashId,
        });
        await clearLeaseAndHash(deps.leaseStoreConfig, slot).catch(() => undefined);
        await deps.wrapper.reset(slot).catch(() => undefined);
        await writeSlotState(deps.stateDir, slot, {
          phase: 'free' satisfies Phase,
          lastHashId: state.lastHashId,
        });
        return send(res, 409, { error: firstErr.message });
      }
      deps.log(
        `reconcile failed for slot "${slot}", resetting and retrying once: ${(firstErr as Error).message}`
      );
      await writeSlotState(deps.stateDir, slot, {
        phase: 'resetting' satisfies Phase,
        lastHashId: state.lastHashId,
      });
      try {
        // Revoke first (F10): clearing the lease and hash cannot make
        // anything less safe, and doing it before the wrapper runs means a
        // teardown that then fails still leaves no live access behind.
        await clearLeaseAndHash(deps.leaseStoreConfig, slot);
        await deps.wrapper.reset(slot);
        await deps.drainFlags.set(slot, 'a');
        await deps.drainFlags.set(slot, 'b');
        await attempt();
      } catch (secondErr) {
        deps.log(`reconcile retry also failed for slot "${slot}": ${(secondErr as Error).message}`);
        await writeSlotState(deps.stateDir, slot, {
          phase: 'error' satisfies Phase,
          lastHashId: state.lastHashId,
        });
        return send(res, 503, { slot, phase: 'error' });
      }
    }

    await writeSlotState(deps.stateDir, slot, {
      phase: 'running' satisfies Phase,
      colour: FRESH_COLOUR,
      descriptorHash: hash,
      lastHashId: newHashId,
    });
    send(res, 200, { slot, phase: 'running', colour: FRESH_COLOUR });
  } finally {
    deps.slotLock.release(slot);
  }
}

/**
 * Raised only immediately before the one step that would leave a single
 * colour as the slot's whole upstream: refusing it is the control LLD-4
 * §U3b names ("draining is refused while the other colour reports 503"),
 * because a slot with both colours drained has no healthy upstream at all
 * and every reader gets 502 (see this file's own sabotage test for what
 * removing this check does to that state).
 */
export class OtherColourUnhealthyError extends Error {
  constructor(readonly colour: Colour) {
    super(
      `colour "${colour}" is not answering 200 -- refusing to drain the colour it would leave as this slot's only upstream`
    );
    this.name = 'OtherColourUnhealthyError';
  }
}

/**
 * The swap LLD-4 §U3b describes: a slot already `running` one colour gets
 * a new descriptor deployed into the *other* one, live, with the first
 * colour still serving throughout. Called only once the caller has
 * confirmed `state.phase === 'running'` and `state.colour` is set; holds
 * the same per-slot lock `handleReconcile` already claimed, and both reads
 * and writes that lock's response itself so its caller can simply `return`
 * whatever this resolves to.
 *
 * **Never calls `deps.wrapper.reset()`.** That is the one thing this
 * function must not do that a fresh deploy's own retry path does on
 * failure (see `attempt()`, above): `reset` stops and wipes *both*
 * colours, and `state.colour` -- the one already running -- is still
 * genuinely serving readers for the entire duration of a swap attempt.
 * "Draining is not stopping" (LLD-4 §U3b, load-bearing) protects the old
 * colour just as much during a failed promotion as during a deliberate
 * rollback: a swap that cannot complete leaves the slot exactly as it
 * found it, never as an outage.
 */
async function attemptColourSwap(
  deps: BrokerDeps,
  res: ServerResponse,
  slot: SlotName,
  state: SlotState,
  descriptor: TenantDescriptor,
  host: string,
  argon2idHash: string,
  hash: string,
  newHashId: HashId
): Promise<void> {
  const liveColour = state.colour as Colour;
  const target = otherColour(liveColour);

  const heldBy = await hostHeldByAnotherSlot(deps.leaseStoreConfig.slotsPath, host, slot);
  if (heldBy !== null) {
    return send(res, 409, { error: `host "${host}" is already held by slot "${heldBy}"` });
  }
  // Both colours share one database, so a swap carries the running
  // tenancy's data into whatever it deploys. A descriptor for a different
  // host is a different tenancy: that is a recycle, which only `/reset`
  // (which wipes the data) may start.
  const runningHost = await hostOfSlotEntry(deps.leaseStoreConfig.slotsPath, slot);
  if (runningHost !== host) {
    return send(res, 409, {
      error: `slot "${slot}" is running a different tenancy (host "${runningHost ?? 'none'}") -- /reset it first`,
    });
  }

  // Drained before the marker below is written, never after. Recovery reads
  // "target's flag is clear" as "target was rebuilt by this swap", and that
  // only holds if the flag cannot be clear at any instant the marker is on
  // disk before this swap's own `clear(target)`. The target is routinely
  // left live and undrained by the previous swap in the other direction,
  // still running the version before last; draining it here is safe
  // because `liveColour` is serving and is preferred or about to stay so.
  await deps.drainFlags.set(slot, target);

  // Recorded before any other side effect below, mirroring the fresh-deploy
  // path's own `preparing` write: a crash partway through this function is
  // otherwise invisible to `recoverCrashedSlots` (the persisted phase would
  // stay `running`/`liveColour` for the swap's whole duration, exactly the
  // gap a review of this story's first cycle found -- a retried /reconcile
  // after such a crash would believe `liveColour` is still live and could
  // drain the colour that crash actually left serving). `swapTarget` plus
  // the new descriptor's own hash/hashId are what let
  // `recoverSwapInFlight` (`stateStore.ts`) tell "a swap into `target` was
  // in flight" apart from "this slot is quietly running", and adopt the
  // right colour with the right hash if it finds `target` already safely
  // live.
  async function restorePreSwapState(): Promise<void> {
    await writeSlotState(deps.stateDir, slot, {
      phase: 'running' satisfies Phase,
      colour: liveColour,
      descriptorHash: state.descriptorHash,
      lastHashId: state.lastHashId,
    });
  }
  await writeSlotState(deps.stateDir, slot, {
    phase: 'swapping' satisfies Phase,
    colour: liveColour,
    // The source's own hash, so a recovery that reverts to it restores
    // idempotent replay rather than recording no hash at all.
    descriptorHash: state.descriptorHash,
    swapTarget: target,
    swapDescriptorHash: hash,
    swapHashId: newHashId,
    lastHashId: state.lastHashId,
  });

  try {
    const artefacts = await deps.renderer.render(descriptor);
    await writeArtefacts(deps.slotDirBase, slot, artefacts);
    await deps.wrapper.start(slot, target);
    const targetPort = slotPort(deps.appPortBase, slot, target);
    await deps.adminApi.configure(`http://127.0.0.1:${targetPort}`, descriptor);
    // "Migrate, verify by calling it directly" (LLD-4 §U3b) -- Ghost's own
    // app port is never ambiguous between colours (unlike the slot's one
    // shared health port), so this needs no router to ask a specific
    // colour whether it is ready.
    const ready = await waitUntilReady(
      deps.ghostReadiness,
      targetPort,
      deps.ghostReadyPollTimeoutMs
    );
    if (!ready) {
      throw new Error(
        `colour "${target}" of slot "${slot}" never answered 200 within ${deps.ghostReadyPollTimeoutMs}ms`
      );
    }
    // Same tenancy, so the lease survives: rotating it here would log out
    // every reader holding a gate cookie. It still rotates if the hash
    // changed, since the lease is tied to the hash it was issued against.
    await writeLeaseAndHash(deps.leaseStoreConfig, host, slot, argon2idHash, {
      keepTiedLease: true,
    });
    await deps.drainFlags.clear(slot, target);
  } catch (err) {
    // `target`'s flag is left exactly as `set`/`clear` above last reached
    // it; the persisted slot state is restored to exactly what it was
    // before this attempt -- still `running`, still `liveColour`, still
    // the old hash -- so a caller that reads `/status` or retries
    // `/reconcile` with the old descriptor sees the tenancy exactly as it
    // was before this attempt. (A real crash instead of this synchronous
    // catch never reaches this line at all; that is `recoverSwapInFlight`'s
    // job, above.)
    await restorePreSwapState();
    deps.log(
      `colour swap failed for slot "${slot}" (target "${target}"): ${(err as Error).message}`
    );
    return send(res, 503, {
      slot,
      phase: 'running',
      colour: liveColour,
      error: (err as Error).message,
    });
  }

  // Moving the traffic. The colours alternate, so the order in the edge's
  // static upstream list can never encode "prefer the newer one" -- what
  // makes the swap work in both directions is that a new colour always
  // boots drained (above), combined with Caddy's `lb_policy first`
  // preferring the first-listed, healthy upstream (LLD-4 §U3b):
  //
  // - Deploying into the first-listed colour ('a'): clearing its flag,
  //   just above, is already the one flag change that moves everything --
  //   it is healthy and first, so nothing further runs here.
  // - Deploying into the second-listed colour ('b'): clearing its flag
  //   moved nothing, because 'a' is still healthy and still preferred.
  //   Only now, draining 'a', does traffic actually move -- which is
  //   exactly why the refusal below guards this branch and no other.
  if (target === 'b') {
    // The Done-means refusal: never drain `liveColour` unless `target` --
    // about to become this slot's only upstream -- is demonstrably
    // serving. This is a second, independent check, not a re-read of the
    // readiness poll above: it runs immediately before the flag change
    // that actually moves traffic, so a target that regressed in the
    // narrow window between the two still refuses here rather than
    // draining blind.
    const targetPort = slotPort(deps.appPortBase, slot, target);
    const stillReady = await deps.ghostReadiness.isReady(targetPort);
    if (!stillReady) {
      await restorePreSwapState();
      const err = new OtherColourUnhealthyError(target);
      deps.log(`colour swap for slot "${slot}" refused to drain "${liveColour}": ${err.message}`);
      return send(res, 503, { slot, phase: 'running', colour: liveColour, error: err.message });
    }
    await deps.drainFlags.set(slot, liveColour);
  }

  await writeSlotState(deps.stateDir, slot, {
    phase: 'running' satisfies Phase,
    colour: target,
    descriptorHash: hash,
    lastHashId: newHashId,
  });
  send(res, 200, { slot, phase: 'running', colour: target });
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

  // Same lock as `/reconcile` (F1): a reset racing an in-flight reconcile
  // must not tear down a slot that reconcile still believes it owns.
  if (!deps.slotLock.claim(slot)) {
    return send(res, 409, { error: `slot "${slot}" is locked by a concurrent request` });
  }
  try {
    const state = await readSlotState(deps.stateDir, slot);
    await writeSlotState(deps.stateDir, slot, {
      phase: 'resetting' satisfies Phase,
      lastHashId: state.lastHashId,
    });
    // Revoke first (F10): a teardown that then fails must still leave no
    // live access behind, rather than leaving the previous visitor's
    // passphrase admitting for as long as the slot sits in `error`.
    await clearLeaseAndHash(deps.leaseStoreConfig, slot);
    try {
      await deps.wrapper.reset(slot);
    } catch (err) {
      deps.log(`reset failed for slot "${slot}": ${(err as Error).message}`);
      await writeSlotState(deps.stateDir, slot, {
        phase: 'error' satisfies Phase,
        lastHashId: state.lastHashId,
      });
      return send(res, 503, { slot, phase: 'error' });
    }
    // A new colour always boots drained (LLD-2 §01b); setting both here
    // means the invariant already holds the instant a next `/reconcile`
    // looks at this slot, rather than depending on `/reconcile` alone to
    // establish it.
    await deps.drainFlags.set(slot, 'a');
    await deps.drainFlags.set(slot, 'b');
    await writeSlotState(deps.stateDir, slot, {
      phase: 'free' satisfies Phase,
      lastHashId: state.lastHashId,
    });
    send(res, 200, { slot, phase: 'free' });
  } finally {
    deps.slotLock.release(slot);
  }
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
        let slotParam: string;
        try {
          slotParam = decodeURIComponent(statusMatch[1] ?? '');
        } catch {
          // A malformed percent-escape (e.g. `%zz`) throws URIError. It is
          // not a shape any of the seven slot literals can ever take, so it
          // answers exactly like one that decodes cleanly but still isn't
          // one of them: 404, not a 500 that leaks that decoding was
          // attempted at all.
          return send(res, 404);
        }
        return await handleStatus(deps, slotParam, res);
      }
      send(res, 404);
    } catch (err) {
      deps.log(`broker error: ${(err as Error).name}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    }
  };
}
