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
import type { DemoBroker } from './controlPlaneDemoBroker.js';
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
  /** This worker could not build or sign the descriptor. Nothing was sent. */
  | 'internal';

export type ProvisionOutcome =
  | {
      readonly state: 'LIVE';
      readonly slot: SlotName;
      readonly hostname: string;
      readonly colour: Colour;
      readonly attempts: 1 | 2;
      readonly expiresAt: Date;
      /** For the arrival mail, once. Held nowhere else. */
      readonly passphrase: string;
    }
  | {
      readonly state: 'FAILED';
      readonly slot: SlotName;
      readonly hostname: string;
      readonly attempts: 1 | 2;
      readonly reason: FailureReason;
      /** The final reset did not free the slot: it needs a person. */
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
  | { readonly ok: true; readonly colour: Colour; readonly passphrase: string }
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

  let reply = await deps.broker.reconcile(slot, descriptor);
  for (let sent = 0; reply.kind === 'unanswered' && sent < deps.resendLimit; sent++) {
    deps.log(`provision slot ${slot}: reconcile unanswered, sending it again unchanged`);
    reply = await deps.broker.reconcile(slot, descriptor);
  }
  if (reply.kind === 'refused') {
    deps.log(`provision slot ${slot}: reconcile refused (${reply.status})`);
    return { ok: false, reason: 'refused', retryable: false, ours: false };
  }
  if (reply.kind === 'unanswered') {
    return { ok: false, reason: 'unanswered', retryable: true, ours: true };
  }
  if (reply.kind === 'failed') {
    return { ok: false, reason: 'broker-error', retryable: true, ours: true };
  }

  const verdict = await pollUntilHealthy(deps, slot);
  if (verdict === 'healthy') return { ok: true, colour: reply.colour, passphrase };
  return { ok: false, reason: 'unhealthy', retryable: true, ours: true };
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
 * never one served and unrecorded) and retired if the demo fails. Entering
 * PROVISIONING issues the term; the descriptor's expiry is that term's end as
 * the database recorded it.
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
  const expiresAt = entered.leaseEndsAt;

  let attempts: 1 | 2 = 1;
  let result = await attemptOnce(deps, slot, label, request.verifiedAddress, expiresAt);
  let slotNeedsAttention = false;

  if (!result.ok && result.retryable) {
    // One retry, after a full reset. The same descriptor would be refused (its
    // hash has not rotated), so the retry carries a fresh passphrase.
    deps.log(
      `provision slot ${slot}: attempt 1 failed (${result.reason}), resetting for one retry`
    );
    if ((await deps.broker.reset(slot)) === 'free') {
      attempts = 2;
      result = await attemptOnce(deps, slot, label, request.verifiedAddress, expiresAt);
    } else {
      result = { ok: false, reason: 'reset-failed', retryable: false, ours: true };
      slotNeedsAttention = true;
    }
  }

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
      passphrase: result.passphrase,
    };
  }

  // The honest ending. The state moves first, so the page never outlives the
  // truth; then the slot is freed, but only if it is ours: a refusal means the
  // broker found the slot held by something else, and that is left alone.
  await store.transition(demoId, 'FAILED');
  if (result.ours && !slotNeedsAttention && (await deps.broker.reset(slot)) !== 'free') {
    slotNeedsAttention = true;
  }
  let hostnameRetired = false;
  try {
    await store.retireHostname(label);
    hostnameRetired = true;
  } catch (error) {
    deps.log(`provision slot ${slot}: hostname not retired (${(error as Error).name})`);
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
