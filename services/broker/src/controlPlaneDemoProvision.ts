/**
 * The control-plane lifecycle worker's provisioning step (LLD-12 section 03,
 * CLAIMED to LIVE or FAILED): a recorded request becomes a validated
 * descriptor, goes to the broker as a signed reconcile over the tunnel, and
 * is polled until the slot is `running` and answers healthy. Success is never
 * inferred from the reconcile's own 200 or from a unit starting. A failure
 * costs one automatic retry, after a full reset and with a fresh passphrase,
 * and then ends in FAILED: a terminal state the prospect's page shows as a
 * failure, never an endless wait. See controlPlaneDemoProvision.md.
 */
import type { SlotName, TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import type { DemoBroker, ResetReply } from './controlPlaneDemoBroker.js';
import { buildDemoDescriptor, type DemoEstate } from './controlPlaneDemoDescriptor.js';
import type { GateIssuer } from './controlPlaneDemoGate.js';
import type { Colour } from './literals.js';

/** The demo states this step reads or writes: a closed subset of the lifecycle's. */
export type ProvisionState = 'CLAIMED' | 'PROVISIONING' | 'LIVE' | 'FAILED';

export interface StoredEvent {
  readonly toState: string;
  /** The end of the term, on the database's clock; null before one exists. */
  readonly leaseEndsAt: Date | null;
}

/**
 * The part of the lifecycle store this step uses. The portal data layer's
 * `ProvisionerDb` (the insert-only `portal_provisioner` role) has these
 * methods with these shapes, so it is passed in as it is; this package does
 * not depend on the portal.
 */
export interface LifecycleStore {
  currentState(demoId: string): Promise<StoredEvent | undefined>;
  request(demoId: string): Promise<{ readonly verifiedAddress: string } | undefined>;
  hostname(demoId: string): Promise<string | null>;
  allocateHostname(demoId: string): Promise<string>;
  transition(demoId: string, to: ProvisionState): Promise<StoredEvent>;
  retireHostname(label: string): Promise<void>;
}

/** What the arrival mail is built from. Nothing here is ever logged. */
export interface Arrival {
  /** The prospect's verified address. */
  readonly address: string;
  /** The demo's hostname label. */
  readonly hostname: string;
  /** The gate's passphrase, once. The mail is the only place it goes. */
  readonly passphrase: string;
  /** The end of the term. */
  readonly expiresAt: Date;
}

export interface ProvisionDeps {
  readonly store: LifecycleStore;
  readonly broker: DemoBroker;
  readonly estate: DemoEstate;
  readonly gate: GateIssuer;
  /** The seams a test replaces: time and waiting. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
  /** How long between status reads. */
  readonly pollIntervalMs: number;
  /** How long one attempt may take, from the reconcile's answer to a healthy slot. */
  readonly provisionTimeoutMs: number;
  /** How many times an unanswered reconcile is sent again, unchanged, before the attempt counts as failed. */
  readonly resendLimit: number;
  /**
   * Sends the arrival mail (the owner's copy first, then the prospect's: see
   * controlPlaneDemoOwnerCopy.md) and resolves only once it has gone. It is
   * called once per attempt, on a slot that answered healthy, and BEFORE LIVE
   * is recorded: a demo is never LIVE with a passphrase nobody was sent. It
   * throws when the mail was not sent, and the attempt then fails.
   */
  readonly sendArrival: (arrival: Arrival) => Promise<void>;
  /** Reason codes only: never a passphrase, hash, address or response body. */
  readonly log: (line: string) => void;
}

/** Why a provision ended in FAILED, as a closed set. */
export type FailureReason =
  /** The broker refused the request. Final; the slot is left exactly as found. */
  | 'refused'
  /** The broker's own reset-and-retry-once was spent. */
  | 'broker-error'
  /** The slot was `running` but never answered healthy inside the timeout, or went to an error phase. */
  | 'unhealthy'
  /** The host never answered a reconcile, however often it was sent. */
  | 'unanswered'
  /** The reset between the two attempts did not free the slot. */
  | 'reset-failed'
  /** The slot was healthy but the arrival mail could not be sent, so nobody could enter it. */
  | 'mail'
  /**
   * This worker could not build or sign the descriptor (nothing was sent), or
   * it threw after PROVISIONING was recorded: the slot's state is unknown.
   */
  | 'internal';

export type ProvisionOutcome =
  | {
      readonly state: 'LIVE';
      readonly slot: SlotName;
      readonly hostname: string;
      readonly colour: Colour;
      readonly attempts: 1 | 2;
      readonly expiresAt: Date;
    }
  | {
      readonly state: 'FAILED';
      readonly slot: SlotName;
      readonly hostname: string;
      readonly attempts: 1 | 2;
      readonly reason: FailureReason;
      /**
       * The slot was not freed, or its state is unknown: it needs a person.
       * Its hostname is then left unretired, which is what keeps the slot
       * counted as held (the data layer's `admit`) until the person has acted.
       */
      readonly slotNeedsAttention: boolean;
      readonly hostnameRetired: boolean;
    };

/** The demo is not CLAIMED: nothing is sent, nothing is changed. */
export class DemoNotClaimedError extends Error {
  constructor(
    readonly demoId: string,
    readonly state: string | undefined
  ) {
    super(`demo ${demoId} is ${state ?? 'unknown'}, not CLAIMED: it is not provisioned`);
    this.name = 'DemoNotClaimedError';
  }
}

/** The demo has no recorded request, or the store holds no term for it. */
export class DemoRecordMissingError extends Error {
  constructor(
    readonly demoId: string,
    readonly what: 'request' | 'term'
  ) {
    super(`demo ${demoId} has no ${what}`);
    this.name = 'DemoRecordMissingError';
  }
}

type AttemptResult =
  | { readonly ok: true; readonly colour: Colour }
  | {
      readonly ok: false;
      readonly reason: FailureReason;
      readonly retryable: boolean;
      /** The slot may hold something of ours to reset. False when the broker refused the request. */
      readonly ours: boolean;
    };

/**
 * One attempt: a fresh passphrase, a validated descriptor, a signed reconcile
 * (sent again unchanged while unanswered: idempotent on slot and descriptor
 * hash), then the poll. The descriptor is built once and every send of it is
 * the same bytes.
 */
async function attemptOnce(
  deps: ProvisionDeps,
  slot: SlotName,
  label: string,
  ownerEmail: string,
  expiresAt: Date
): Promise<AttemptResult> {
  let descriptor: TenantDescriptor;
  let passphrase: string;
  try {
    const issued = await deps.gate.issue();
    passphrase = issued.passphrase;
    descriptor = buildDemoDescriptor(
      { slot, label, ownerEmail, expiresAt, argon2idHash: issued.argon2idHash },
      deps.estate
    );
  } catch (error) {
    deps.log(`provision slot ${slot}: descriptor not built (${(error as Error).name})`);
    return { ok: false, reason: 'internal', retryable: false, ours: false };
  }

  // An unanswered reconcile is sent again, unchanged, up to `resendLimit`. A
  // `locked` answer means an earlier send is still running (the broker holds
  // the slot lock for all of a reconcile, which can outlast the call's own
  // deadline): wait and send again until `provisionTimeoutMs` has passed. The
  // resend is never a refusal and never a reset: the slot is ours and busy.
  const lockedUntil = deps.nowMs() + deps.provisionTimeoutMs;
  let resent = 0;
  let reply = await deps.broker.reconcile(slot, descriptor);
  for (;;) {
    if (reply.kind === 'unanswered' && resent < deps.resendLimit) {
      resent += 1;
      deps.log(`provision slot ${slot}: reconcile unanswered, sending it again unchanged`);
    } else if (reply.kind === 'locked' && deps.nowMs() < lockedUntil) {
      deps.log(`provision slot ${slot}: reconcile still running, sending it again later`);
      await deps.sleep(deps.pollIntervalMs);
    } else {
      break;
    }
    reply = await deps.broker.reconcile(slot, descriptor);
  }
  if (reply.kind === 'refused') {
    deps.log(`provision slot ${slot}: reconcile refused (${reply.status})`);
    return { ok: false, reason: 'refused', retryable: false, ours: false };
  }
  if (reply.kind === 'unanswered' || reply.kind === 'locked') {
    return { ok: false, reason: 'unanswered', retryable: true, ours: true };
  }
  if (reply.kind === 'failed') {
    return { ok: false, reason: 'broker-error', retryable: true, ours: true };
  }

  const verdict = await pollUntilHealthy(deps, slot);
  if (verdict !== 'healthy') return { ok: false, reason: 'unhealthy', retryable: true, ours: true };

  // The mail goes before LIVE is recorded: the passphrase is held nowhere
  // else, so a LIVE demo whose mail never went would have an unrecoverable gate.
  try {
    await deps.sendArrival({ address: ownerEmail, hostname: label, passphrase, expiresAt });
  } catch (error) {
    deps.log(`provision slot ${slot}: arrival mail not sent (${(error as Error).name})`);
    return { ok: false, reason: 'mail', retryable: true, ours: true };
  }
  return { ok: true, colour: reply.colour };
}

/**
 * A reset, tried again while the broker answers `locked` (a reconcile still
 * running) until `provisionTimeoutMs` has passed. Any other answer is final.
 */
async function resetSlot(deps: ProvisionDeps, slot: SlotName): Promise<ResetReply> {
  const until = deps.nowMs() + deps.provisionTimeoutMs;
  for (;;) {
    const reply = await deps.broker.reset(slot);
    if (reply !== 'locked' || deps.nowMs() >= until) return reply;
    deps.log(`provision slot ${slot}: reset found the slot locked, trying again later`);
    await deps.sleep(deps.pollIntervalMs);
  }
}

/**
 * Reads the slot until it is `running` and its colour answers healthy. A
 * slot that has gone to an error phase, or back to free, is a failure now
 * rather than at the deadline; a status that cannot be read is tried again
 * until the deadline.
 */
async function pollUntilHealthy(
  deps: ProvisionDeps,
  slot: SlotName
): Promise<'healthy' | 'failed' | 'timeout'> {
  const deadline = deps.nowMs() + deps.provisionTimeoutMs;
  for (;;) {
    const reading = await deps.broker.status(slot);
    if (reading !== undefined) {
      if (reading.phase === 'running' && reading.healthy) return 'healthy';
      if (reading.phase === 'error' || reading.phase === 'free') return 'failed';
    }
    if (deps.nowMs() >= deadline) return 'timeout';
    await deps.sleep(deps.pollIntervalMs);
  }
}

/**
 * Provisions one CLAIMED demo onto the slot the claim named, and leaves it
 * LIVE or FAILED: never PROVISIONING. The hostname is allocated before the
 * descriptor is signed (a crash between the two leaves a name never served,
 * never one served and unrecorded) and retired if the demo fails and its slot
 * was freed. Entering PROVISIONING issues the term; the descriptor's expiry is
 * that term's end as the database recorded it. A throw after PROVISIONING is
 * recorded is caught and ends FAILED with the slot flagged for a person.
 *
 * @throws DemoNotClaimedError when the demo is not CLAIMED
 * @throws DemoRecordMissingError when there is no request or no term to build from
 */
export async function provisionDemo(
  deps: ProvisionDeps,
  demoId: string,
  slot: SlotName
): Promise<ProvisionOutcome> {
  const { store } = deps;
  const current = await store.currentState(demoId);
  if (current?.toState !== 'CLAIMED') throw new DemoNotClaimedError(demoId, current?.toState);
  const request = await store.request(demoId);
  if (request === undefined) throw new DemoRecordMissingError(demoId, 'request');

  const label = (await store.hostname(demoId)) ?? (await store.allocateHostname(demoId));
  const entered = await store.transition(demoId, 'PROVISIONING');
  if (entered.leaseEndsAt === null) throw new DemoRecordMissingError(demoId, 'term');

  const progress = { attempts: 1 as 1 | 2 };
  try {
    return await runAttempts(
      deps,
      demoId,
      slot,
      label,
      request.verifiedAddress,
      entered.leaseEndsAt,
      progress
    );
  } catch (error) {
    return await failAfterThrow(deps, demoId, slot, label, progress.attempts, error);
  }
}

/**
 * A throw after PROVISIONING: a bad signing key, a database error, anything
 * unforeseen. The demo is moved to FAILED so the page stops waiting, unless it
 * already is; the slot's state is unknown, so it is flagged for a person and
 * the hostname is left unretired, which keeps the slot held. If the store
 * cannot record FAILED either, the original error is thrown: nothing more can
 * be done from here, and the demo stays PROVISIONING.
 */
async function failAfterThrow(
  deps: ProvisionDeps,
  demoId: string,
  slot: SlotName,
  label: string,
  attempts: 1 | 2,
  error: unknown
): Promise<ProvisionOutcome> {
  try {
    const latest = await deps.store.currentState(demoId);
    if (latest?.toState === 'PROVISIONING') await deps.store.transition(demoId, 'FAILED');
  } catch {
    throw error;
  }
  deps.log(
    `provision slot ${slot}: threw (${(error as Error).name}), recorded FAILED, slot needs attention`
  );
  return {
    state: 'FAILED',
    slot,
    hostname: label,
    attempts,
    reason: 'internal',
    slotNeedsAttention: true,
    hostnameRetired: false,
  };
}

async function runAttempts(
  deps: ProvisionDeps,
  demoId: string,
  slot: SlotName,
  label: string,
  ownerEmail: string,
  expiresAt: Date,
  progress: { attempts: 1 | 2 }
): Promise<ProvisionOutcome> {
  const { store } = deps;
  let result = await attemptOnce(deps, slot, label, ownerEmail, expiresAt);
  let slotNeedsAttention = false;

  if (!result.ok && result.retryable) {
    // One retry, after a full reset. The same descriptor would be refused (its
    // hash has not rotated), so the retry carries a fresh passphrase.
    deps.log(
      `provision slot ${slot}: attempt 1 failed (${result.reason}), resetting for one retry`
    );
    if ((await resetSlot(deps, slot)) === 'free') {
      progress.attempts = 2;
      result = await attemptOnce(deps, slot, label, ownerEmail, expiresAt);
    } else {
      result = { ok: false, reason: 'reset-failed', retryable: false, ours: true };
      slotNeedsAttention = true;
    }
  }
  const attempts = progress.attempts;

  if (result.ok) {
    await store.transition(demoId, 'LIVE');
    deps.log(`provision slot ${slot}: live after ${attempts} attempt(s)`);
    return {
      state: 'LIVE',
      slot,
      hostname: label,
      colour: result.colour,
      attempts,
      expiresAt,
    };
  }

  // The honest ending. The state moves first, so the page never outlives the
  // truth; then the slot is freed, but only if it is ours: a refusal means the
  // broker found the slot held by something else, and that is left alone.
  await store.transition(demoId, 'FAILED');
  if (result.ours && !slotNeedsAttention && (await resetSlot(deps, slot)) !== 'free') {
    slotNeedsAttention = true;
  }
  // A slot that needs a person stays held: its hostname is not retired, and a
  // FAILED demo with an unretired hostname counts against the slots the claim
  // step may offer (ProvisionerDb.admit). The person frees the slot, then
  // retires the hostname.
  let hostnameRetired = false;
  if (slotNeedsAttention) {
    deps.log(`provision slot ${slot}: hostname kept, the slot stays held until a person frees it`);
  } else {
    try {
      await store.retireHostname(label);
      hostnameRetired = true;
    } catch (error) {
      deps.log(`provision slot ${slot}: hostname not retired (${(error as Error).name})`);
    }
  }
  deps.log(`provision slot ${slot}: failed (${result.reason}) after ${attempts} attempt(s)`);
  return {
    state: 'FAILED',
    slot,
    hostname: label,
    attempts,
    reason: result.reason,
    slotNeedsAttention,
    hostnameRetired,
  };
}
