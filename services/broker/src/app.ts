import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createServer as createGeneratedListener,
  routes,
  type Handlers,
  type ListenerOptions,
  type RouteDefinition,
} from './generated/server.js';
import {
  hashIdOf,
  validate,
  type HashId,
  type SlotName,
  type TenantDescriptor,
  type ZoneConfig,
} from '@branchleft/ghost-platform-render-core';
import type { SeamReadiness } from './seamReadiness.js';
import type { AdminApiClient } from './adminApi.js';
import { type AuthDeps, verifyRequest } from './auth.js';
import { descriptorHash } from './descriptorHash.js';
import { EMPTY_DRAIN_PAYLOAD, type DrainPayload, type DrainSource } from './drainSource.js';
import type { DrainFlagStore } from './drainFlag.js';
import type { EmailBatchChecker } from './emailBatchChecker.js';
import type { GhostReadinessChecker } from './ghostReadiness.js';
import { waitUntilReady } from './ghostReadiness.js';
import type { HealthChecker } from './healthCheck.js';
import { hostOf } from './hostOf.js';
import {
  authenticateImagePush,
  readImageHeaders,
  receiveImage,
  type ImagePushDeps,
} from './imagePush.js';
import { clearLeaseAndHash, writeLeaseAndHash, type LeaseStoreConfig } from './leaseStore.js';
import { otherColour, validateSlotLiteral, type Colour } from './literals.js';
import type { RealTrafficChecker } from './realTraffic.js';
import type { Renderer } from './render.js';
import { type SlotLock } from './slotLock.js';
import { slotAllocation, slotPort } from './slotPorts.js';
import { HostConflictError, hostHeldByAnotherSlot, hostOfSlotEntry } from './slotsFile.js';
import {
  assertHashRotated,
  readSlotState,
  resetRefusal,
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
  /** Which loaded seams are not shipped final modules (`seamReadiness.ts`); reported by `/status`. */
  readonly seamReadiness: SeamReadiness;
  readonly leaseStoreConfig: LeaseStoreConfig;
  readonly drainFlags: DrainFlagStore;
  readonly imagePush: ImagePushDeps;
  readonly healthChecker: HealthChecker;
  readonly ghostReadiness: GhostReadinessChecker;
  /** The first stop-old-colour pre-stop check: the falsification clause's "served real traffic". */
  readonly realTraffic: RealTrafficChecker;
  /** The second stop-old-colour pre-stop check: LLD-4 §U5's "no send in flight". */
  readonly emailBatchChecker: EmailBatchChecker;
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

/**
 * What a handler returns: the generated adapter writes it. `Cache-Control:
 * no-store` rides on every one, as `send` has always put it on every answer.
 */
const NO_STORE: Record<string, string> = { 'Cache-Control': 'no-store' };

function reply<Status extends number, const Body>(
  status: Status,
  body: Body
): { status: Status; body: Body; headers: Record<string, string> } {
  return { status, body, headers: NO_STORE };
}

type ReconcileResult = Awaited<ReturnType<Handlers['reconcileSlot']>>;
type StopResult = Awaited<ReturnType<Handlers['stopSlot']>>;
type ResetResult = Awaited<ReturnType<Handlers['resetSlot']>>;
type StatusResult = Awaited<ReturnType<Handlers['getSlotStatus']>>;
type DrainResult = Awaited<ReturnType<Handlers['pollDrainQueue']>>;
type PushResult = Awaited<ReturnType<Handlers['pushImage']>>;
type ReconcileBody = Parameters<Handlers['reconcileSlot']>[0]['body'];
type SlotBody = Parameters<Handlers['resetSlot']>[0]['body'];

async function handleReconcile(deps: BrokerDeps, body: ReconcileBody): Promise<ReconcileResult> {
  // `body` has already passed the request gate (`createGate`): signed, JSON,
  // an enumerated slot literal, and the spec's own schema. The slot is
  // re-derived here only to get its branded type back.
  const slot: SlotName = validateSlotLiteral(body.slot, deps.slotLiterals);

  let descriptor: TenantDescriptor;
  try {
    descriptor = validate(body.descriptor as unknown as TenantDescriptor, deps.zones);
  } catch (err) {
    return reply(400, { error: (err as Error).message });
  }
  if (descriptor.kind !== 'demo') {
    return reply(400, { error: 'the broker reconciles demo descriptors only' });
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
    return reply(500, { error: 'a validated demo descriptor had no passphrase gate' });
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
    return reply(400, {
      error: `descriptor's uid/ports don't match slot "${slot}"'s own allocation`,
    });
  }

  // LLD-2 §04's `preparing` phase, restored: nothing below this point runs
  // for this slot without holding its lock, so a `/reset` (or a second
  // `/reconcile`) racing this one sees an occupied slot for the whole
  // attempt, not only after it finishes.
  if (!deps.slotLock.claim(slot)) {
    return reply(409, { error: `slot "${slot}" is locked by a concurrent request` });
  }
  try {
    const state = await readSlotState(deps.stateDir, slot);

    // Idempotent replay: LLD-2 §04. No side effect runs a second time for
    // an identical (slot, descriptorHash) pair.
    if (state.phase === 'running' && state.descriptorHash === hash && state.colour !== undefined) {
      return reply(200, { slot, phase: state.phase, colour: state.colour });
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
      return reply(409, { error: `slot "${slot}" is occupied (phase "${state.phase}")` });
    }
    // A free slot still carrying unconfirmed evidence must not enter the
    // fresh-deploy path: its failure branch resets the slot.
    const evidenceRefusal = resetRefusal(state, slot);
    if (evidenceRefusal !== undefined) {
      return reply(409, { error: evidenceRefusal });
    }
    try {
      assertHashRotated(state, newHashId, slot);
    } catch (err) {
      if (!(err instanceof UnrotatedHashError)) throw err;
      return reply(409, { error: err.message });
    }
    const heldBy = await hostHeldByAnotherSlot(deps.leaseStoreConfig.slotsPath, host, slot);
    if (heldBy !== null) {
      return reply(409, { error: `host "${host}" is already held by slot "${heldBy}"` });
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
      await deps.adminApi.configure(`http://127.0.0.1:${port}`, descriptor, slot);
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
        try {
          await clearLeaseAndHash(deps.leaseStoreConfig, slot);
          await deps.adminApi.forget?.(slot);
          await deps.wrapper.reset(slot);
        } catch (teardownErr) {
          // Same rule as `/reset`: a slot is only ever `free` after its
          // wipe succeeded, or the next visitor could get this site.
          deps.log(
            `teardown after host conflict failed for slot "${slot}": ${(teardownErr as Error).message}`
          );
          await writeSlotState(deps.stateDir, slot, {
            phase: 'error' satisfies Phase,
            lastHashId: state.lastHashId,
          });
          return reply(503, { slot, phase: 'error' });
        }
        await writeSlotState(deps.stateDir, slot, {
          phase: 'free' satisfies Phase,
          lastHashId: state.lastHashId,
        });
        return reply(409, { error: firstErr.message });
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
        await deps.adminApi.forget?.(slot);
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
        return reply(503, { slot, phase: 'error' });
      }
    }

    await writeSlotState(deps.stateDir, slot, {
      phase: 'running' satisfies Phase,
      colour: FRESH_COLOUR,
      descriptorHash: hash,
      lastHashId: newHashId,
    });
    return reply(200, { slot, phase: 'running', colour: FRESH_COLOUR });
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
 * Deploys a new descriptor into a running slot's other colour, live, while
 * the first colour keeps serving throughout. Never calls
 * `deps.wrapper.reset()`: that would stop and wipe both colours, and the
 * live one is still genuinely serving readers for the whole attempt.
 * See app.md#attemptcolourswap.
 */
async function attemptColourSwap(
  deps: BrokerDeps,
  slot: SlotName,
  state: SlotState,
  descriptor: TenantDescriptor,
  host: string,
  argon2idHash: string,
  hash: string,
  newHashId: HashId
): Promise<ReconcileResult> {
  const liveColour = state.colour as Colour;
  const target = otherColour(liveColour);

  const heldBy = await hostHeldByAnotherSlot(deps.leaseStoreConfig.slotsPath, host, slot);
  if (heldBy !== null) {
    return reply(409, { error: `host "${host}" is already held by slot "${heldBy}"` });
  }
  // Both colours share one database, so a swap carries the running
  // tenancy's data into whatever it deploys. A descriptor for a different
  // host is a different tenancy: that is a recycle, which only `/reset`
  // (which wipes the data) may start.
  const runningHost = await hostOfSlotEntry(deps.leaseStoreConfig.slotsPath, slot);
  if (runningHost !== host) {
    return reply(409, {
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

  // Recorded before any other side effect, mirroring the fresh-deploy path's
  // own `preparing` write: without it, a crash partway through this function
  // is invisible to `recoverCrashedSlots`. See app.md#attemptcolourswap.
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
    await deps.adminApi.configure(`http://127.0.0.1:${targetPort}`, descriptor, slot);
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
    return reply(503, {
      slot,
      phase: 'running',
      colour: liveColour,
      error: (err as Error).message,
    });
  }

  // Moving the traffic: the swap works in both directions because a new
  // colour always boots drained, combined with the edge's `lb_policy first`
  // preferring the first-listed, healthy upstream. Only the second-listed
  // colour's branch below needs to explicitly drain the survivor.
  // See app.md#attemptcolourswap-traffic-move.
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
      return reply(503, { slot, phase: 'running', colour: liveColour, error: err.message });
    }
    await deps.drainFlags.set(slot, liveColour);
  }

  // The stop-old-colour baseline: taken here, once, at the instant the swap's
  // own traffic-moving step is done -- not read again later by
  // `attemptStopOldColour`'s own check, which must see it *advance* from
  // this fixed point rather than the checker's current value at every
  // call. Read after the state write would risk a real request landing in
  // the gap and being silently absorbed into "the starting point" instead
  // of "evidence of progress"; reading it first, here, costs nothing and
  // cannot manufacture false evidence the other direction.
  const trafficBaseline = await deps.realTraffic.readCount(slot);
  await writeSlotState(deps.stateDir, slot, {
    phase: 'running' satisfies Phase,
    colour: target,
    descriptorHash: hash,
    lastHashId: newHashId,
    trafficBaseline,
  });
  return reply(200, { slot, phase: 'running', colour: target });
}

/**
 * Stops the colour a completed swap left running, drained, for the whole
 * bake window. Requires `state.trafficBaseline` to be set, which is what
 * distinguishes a tenancy that arrived by a swap from a fresh deploy.
 * Three independent refusal checks guard the one irreversible side effect.
 * See app.md#attemptstopoldcolour.
 */
async function attemptStopOldColour(
  deps: BrokerDeps,
  slot: SlotName,
  state: SlotState
): Promise<StopResult> {
  if (state.colour === undefined || state.trafficBaseline === undefined) {
    return reply(409, {
      error: `slot "${slot}" has no old colour to stop -- its current tenancy was not reached by a colour swap`,
    });
  }
  if (state.oldColourStopped === true) {
    // Idempotent replay (the same discipline `handleReconcile` gives a
    // repeated identical descriptor): neither check below needs to run
    // again for a step that already happened.
    return reply(200, { slot, phase: 'running', colour: state.colour });
  }

  const liveColour = state.colour;
  const oldColour = otherColour(liveColour);

  const currentTraffic = await deps.realTraffic.readCount(slot);
  if (currentTraffic <= state.trafficBaseline) {
    return reply(503, {
      slot,
      phase: 'running',
      colour: liveColour,
      error: `colour "${liveColour}" has served no real traffic since its swap completed -- refusing to stop colour "${oldColour}"`,
    });
  }

  if (await deps.emailBatchChecker.hasSubmittingBatch(slot)) {
    return reply(503, {
      slot,
      phase: 'running',
      colour: liveColour,
      error: `slot "${slot}" has an email or batch still "submitting" -- refusing to stop colour "${oldColour}" mid-send`,
    });
  }

  const liveColourPort = slotPort(deps.appPortBase, slot, liveColour);
  const stillLive =
    !(await deps.drainFlags.isSet(slot, liveColour)) &&
    (await deps.ghostReadiness.isReady(liveColourPort));
  if (!stillLive) {
    return reply(503, {
      slot,
      phase: 'running',
      colour: liveColour,
      error: `colour "${liveColour}" is not confirmed live right now -- refusing to stop colour "${oldColour}", which would leave slot "${slot}" with no colour serving`,
    });
  }

  // The in-flight marker, written before the one side effect that follows
  // -- `recoverStoppingSlot` (`stateStore.ts`) is what makes a crash here
  // recoverable rather than an unrecorded stop nobody can tell happened.
  await writeSlotState(deps.stateDir, slot, {
    phase: 'stopping' satisfies Phase,
    colour: liveColour,
    descriptorHash: state.descriptorHash,
    lastHashId: state.lastHashId,
    trafficBaseline: state.trafficBaseline,
  });
  await deps.wrapper.stop(slot, oldColour);
  await writeSlotState(deps.stateDir, slot, {
    phase: 'running' satisfies Phase,
    colour: liveColour,
    descriptorHash: state.descriptorHash,
    lastHashId: state.lastHashId,
    trafficBaseline: state.trafficBaseline,
    oldColourStopped: true,
  });
  return reply(200, { slot, phase: 'running', colour: liveColour });
}

async function handleStop(deps: BrokerDeps, body: SlotBody): Promise<StopResult> {
  const slot: SlotName = validateSlotLiteral(body.slot, deps.slotLiterals);

  // Same lock as `/reconcile` and `/reset` (F1): a stop racing either must
  // not act on a slot either of them still believes it owns.
  if (!deps.slotLock.claim(slot)) {
    return reply(409, { error: `slot "${slot}" is locked by a concurrent request` });
  }
  try {
    const state = await readSlotState(deps.stateDir, slot);
    if (state.phase !== 'running') {
      return reply(409, {
        error: `slot "${slot}" is not in a running state (phase "${state.phase}")`,
      });
    }
    return await attemptStopOldColour(deps, slot, state);
  } finally {
    deps.slotLock.release(slot);
  }
}

async function handleReset(deps: BrokerDeps, body: SlotBody): Promise<ResetResult> {
  const slot: SlotName = validateSlotLiteral(body.slot, deps.slotLiterals);

  // Same lock as `/reconcile` (F1): a reset racing an in-flight reconcile
  // must not tear down a slot that reconcile still believes it owns.
  if (!deps.slotLock.claim(slot)) {
    return reply(409, { error: `slot "${slot}" is locked by a concurrent request` });
  }
  try {
    const state = await readSlotState(deps.stateDir, slot);
    // Held evidence is released only by a confirmed detach, never by a
    // reset: refuse before any write, so the slot is left untouched.
    const refusal = resetRefusal(state, slot);
    if (refusal !== undefined) {
      deps.log(`reset refused: ${refusal}`);
      return reply(409, { error: refusal });
    }
    await writeSlotState(deps.stateDir, slot, {
      phase: 'resetting' satisfies Phase,
      lastHashId: state.lastHashId,
    });
    // Revoke first (F10): a teardown that then fails must still leave no
    // live access behind, rather than leaving the previous visitor's
    // passphrase admitting for as long as the slot sits in `error`.
    await clearLeaseAndHash(deps.leaseStoreConfig, slot);
    try {
      // The slot's Ghost access key goes with its lease, before the wipe:
      // a reset that then fails still leaves no way back into the site.
      await deps.adminApi.forget?.(slot);
      await deps.wrapper.reset(slot);
    } catch (err) {
      deps.log(`reset failed for slot "${slot}": ${(err as Error).message}`);
      await writeSlotState(deps.stateDir, slot, {
        phase: 'error' satisfies Phase,
        lastHashId: state.lastHashId,
      });
      return reply(503, { slot, phase: 'error' });
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
    return reply(200, { slot, phase: 'free' });
  } finally {
    deps.slotLock.release(slot);
  }
}

async function handleStatus(deps: BrokerDeps, slotParam: string): Promise<StatusResult> {
  let slot: SlotName;
  try {
    slot = validateSlotLiteral(slotParam, deps.slotLiterals);
  } catch {
    return reply(404, undefined);
  }
  const state = await readSlotState(deps.stateDir, slot);
  const healthy =
    state.phase === 'running' && state.colour !== undefined
      ? await deps.healthChecker.isHealthy(deps.healthPortBase + Number(slot))
      : false;
  return reply(200, {
    slot,
    phase: state.phase,
    healthy,
    notReal: deps.seamReadiness.notReal.slice(),
    interim: deps.seamReadiness.interim.slice(),
  });
}

/** The generated body type holds mutable arrays; the seam's payload holds readonly ones. */
function drainBody(payload: DrainPayload) {
  return reply(200, { mail: payload.mail.slice(), mediaHashes: payload.mediaHashes.slice() });
}

async function handleDrain(deps: BrokerDeps): Promise<DrainResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.drainPollTimeoutMs);
  try {
    return drainBody(await deps.drainSource.poll(controller.signal));
  } catch (err) {
    if (controller.signal.aborted) {
      // The long-poll's own deadline, not a source failure: LLD-2 §03 says
      // this endpoint only ever answers, so "nothing arrived in time" is a
      // normal empty response, not an error.
      return drainBody(EMPTY_DRAIN_PAYLOAD);
    }
    deps.log(`drain source failed: ${(err as Error).message}`);
    return reply(502, { error: 'drain source unavailable' });
  } finally {
    clearTimeout(timer);
  }
}

async function handlePush(deps: BrokerDeps, req: IncomingMessage): Promise<PushResult> {
  // The gate has already refused a malformed or unsigned push; the headers
  // are read again here only to get the declared digest and size back.
  const headers = readImageHeaders(req, deps.imagePush.maxBytes);
  if (!headers.ok) return reply(headers.status, headers.body);
  const receipt = await receiveImage(deps.imagePush, req, headers);
  return { ...receipt, headers: NO_STORE };
}

/**
 * The broker's side of the generated `Handlers` interface: one method per
 * operation in `openapi.yaml`, each returning only a status and body that
 * operation's responses declare (the compiler checks that). Everything that
 * answers before this point (route, size, signature, JSON, slot, schema)
 * is `createGate`'s.
 */
function createHandlers(deps: BrokerDeps): Handlers {
  return {
    pollDrainQueue: () => handleDrain(deps),
    pushImage: (_request, { rawRequest }) => handlePush(deps, rawRequest),
    reconcileSlot: ({ body }) => handleReconcile(deps, body),
    resetSlot: ({ body }) => handleReset(deps, body),
    getSlotStatus: ({ path }) => handleStatus(deps, path.slot),
    stopSlot: ({ body }) => handleStop(deps, body),
  };
}

/**
 * The response the gate already wrote. The generated adapter treats a throw
 * from `beforeHandle` as a failure and would answer 500 over the top of it;
 * this marks the throw as "answered", so `onError` can recognise it.
 */
class RefusalSent extends Error {}

/**
 * Which `ServerResponse` belongs to a request the generated listener is
 * working on. `beforeHandle` receives only the request and can reject only
 * by throwing, which the adapter turns into a 500 -- so the gate writes its
 * own 401/413/422 straight onto the response and throws `RefusalSent`.
 */
const responses = new WeakMap<IncomingMessage, ServerResponse>();

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const shown = issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || 'body'}: ${issue.message}`);
  return `request body does not match the API contract (${shown.join('; ')})`;
}

/**
 * Runs inside the generated adapter, after it has buffered a JSON body and
 * before it parses, validates or dispatches anything. It keeps the order
 * `authenticate` always had: the signature is checked over the raw bytes
 * first (401), and only then is the body parsed (400), its slot checked
 * (422) and the spec's own schema applied (400). The adapter would answer
 * those last three itself, but as `application/problem+json` with status
 * 400 for all of them, which is not what the spec declares.
 */
function createGate(deps: BrokerDeps): NonNullable<ListenerOptions['beforeHandle']> {
  return async (req, route, rawBody) => {
    // Always present: the front door records it just before it hands the
    // request to the listener, and nothing else reaches this gate.
    const res = responses.get(req) as ServerResponse;
    const refuse = (status: number, body?: unknown): never => {
      send(res, status, body);
      throw new RefusalSent();
    };

    if (route.id === 'getSlotStatus') return; // unauthenticated, and answered 404 by the front door.

    if (route.id === 'pushImage') {
      // Signed over a manifest of two header values, never the body, so it
      // is checked before a byte of the image is read. A refusal drains the
      // upload so the sender sees the answer rather than a reset.
      const headers = readImageHeaders(req, deps.imagePush.maxBytes);
      if (!headers.ok) {
        req.resume();
        return refuse(headers.status, headers.body);
      }
      const authResult = authenticateImagePush(deps.auth, req, headers);
      if (!authResult.ok) {
        req.resume();
        deps.log(`refused ${req.method} ${route.path}: ${authResult.reason}`);
        return refuse(401, { error: authResult.reason });
      }
      return;
    }

    // Every other signed route: `rawBody` is the buffered JSON body, and is
    // undefined for the body-less drain poll, whose signed bytes are empty.
    const raw = rawBody ?? (await readBody(req));
    if (raw === null) return refuse(413);
    const result = verifyRequest(deps.auth, req.method ?? '', route.path, authHeaders(req), raw);
    if (!result.ok) {
      deps.log(`refused ${req.method} ${route.path}: ${result.reason}`);
      return refuse(401);
    }
    if (route.bodyMode !== 'json') return;

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return refuse(400, { error: 'body is not valid JSON' });
    }
    try {
      validateSlotLiteral((payload as { slot?: unknown } | null)?.slot, deps.slotLiterals);
    } catch (err) {
      return refuse(422, { error: (err as Error).message });
    }
    const verdict = route.bodySchema?.safeParse(payload);
    if (verdict !== undefined && !verdict.success) {
      return refuse(400, { error: describeIssues(verdict.error.issues) });
    }
  };
}

interface RouteEntry {
  readonly method: string;
  readonly path: string;
}

/** Every literal-path route this handler serves. See app.md#route-tables. */
export const LITERAL_ROUTES: readonly RouteEntry[] = routes
  .filter((route) => !route.path.includes('{'))
  .map(({ method, path }) => ({ method, path }));

/** The one parameterised route this handler serves. See app.md#route-tables. */
export const STATUS_ROUTE: RouteEntry = (() => {
  // A table without it fails here at import, loudly, on `route.method`.
  const route = routes.find((candidate) => candidate.id === 'getSlotStatus') as RouteDefinition;
  return { method: route.method, path: route.path };
})();

interface RouteMatch {
  readonly route: RouteDefinition;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Matches exactly, by whole segments, against the generated route table.
 * The adapter's own matcher also accepts an empty segment (`/reconcile/`,
 * `//reconcile`) and throws on a bad percent-escape; both must stay a plain
 * 404 here, as they always were.
 */
function matchRoute(method: string, rawPath: string): RouteMatch | undefined {
  if (!rawPath.startsWith('/')) return undefined;
  const actual = rawPath.slice(1).split('/');
  for (const route of routes) {
    if (route.method !== method) continue;
    const template = route.path.slice(1).split('/');
    if (template.length !== actual.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < template.length; i += 1) {
      const want = template[i] ?? '';
      const got = actual[i] ?? '';
      if (got === '') {
        matched = false;
      } else if (want.startsWith('{') && want.endsWith('}')) {
        try {
          params[want.slice(1, -1)] = decodeURIComponent(got);
        } catch {
          matched = false;
        }
      } else if (want !== got) {
        matched = false;
      }
      if (!matched) break;
    }
    if (matched) return { route, params };
  }
  return undefined;
}

/**
 * Every failure path answers with a non-2xx status and an unexpected throw
 * becomes a 500, matching `services/demo-gate`'s own posture: a caller of
 * this endpoint has nothing useful to do with a response that never came.
 *
 * Requests are matched exactly here, then handed to the listener the
 * generated server package builds from `openapi.yaml`; the `Handlers` it
 * dispatches to are `createHandlers`. See app.md#generated-server.
 */
export function createBrokerHandler(deps: BrokerDeps): Handler {
  const listener = createGeneratedListener(createHandlers(deps), {
    maxJsonBodyBytes: MAX_BODY_BYTES,
    beforeHandle: createGate(deps),
    // The adapter has already given the request its answer in these cases
    // (the gate wrote it, or headers had gone out); every other error is
    // a 500 with no body, as before.
    onError: (error, req) => {
      if (error instanceof RefusalSent) return;
      deps.log(`broker error: ${(error as Error).name}: ${(error as Error).message}`);
      const res = responses.get(req) as ServerResponse;
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    },
  });
  return async (req, res) => {
    try {
      const rawPath = (req.url ?? '').split('?')[0] ?? '';
      const match = matchRoute(req.method ?? '', rawPath);
      if (match === undefined) return send(res, 404);
      if (match.route.id === 'getSlotStatus') {
        const literals = deps.slotLiterals;
        try {
          validateSlotLiteral(match.params.slot, literals);
        } catch {
          // Not one of the enumerated literals: answers exactly as an
          // unrouted path does, so a probe learns nothing about which
          // slots exist beyond what /status itself reports.
          return send(res, 404);
        }
      }
      if (match.route.bodyMode === 'json') {
        const declared = Number(req.headers['content-length']);
        if (declared > MAX_BODY_BYTES) return send(res, 413);
      }
      responses.set(req, res);
      listener(req, res);
    } catch (err) {
      deps.log(`broker error: ${(err as Error).name}: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    }
  };
}
