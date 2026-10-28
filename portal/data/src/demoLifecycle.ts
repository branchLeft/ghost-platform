import { randomBytes } from 'node:crypto';
import {
  LABEL_ALPHABET,
  LABEL_LENGTH,
  LABEL_LETTER_MASK,
  isAllowedTransition,
  type DemoState,
} from './demoStates.js';
import type { demoStateEvent } from './schema.js';

export {
  DEMO_STATES,
  DEMO_TRANSITIONS,
  EXTENSION_DAYS,
  LEASE_DAYS,
  NEXT_STATES,
  SLOT_HOLDING_STATES,
  TERMINAL_STATES,
  isAllowedTransition,
  type DemoState,
} from './demoStates.js';

/** One row of a demo's history: the transition, its time on the database clock, the term then in force. */
export interface DemoEventView {
  demoId: string;
  sequence: number;
  fromState: DemoState | null;
  toState: DemoState;
  leaseIssuedAt: Date | null;
  leaseEndsAt: Date | null;
  extensionDays: number;
  recordedAt: Date;
}

export function deriveEventView(row: typeof demoStateEvent.$inferSelect): DemoEventView {
  return {
    demoId: row.demoId,
    sequence: row.sequence,
    fromState: row.fromState as DemoState | null,
    toState: row.toState as DemoState,
    leaseIssuedAt: row.leaseIssuedAt,
    leaseEndsAt: row.leaseEndsAt,
    extensionDays: row.extensionDays,
    recordedAt: row.recordedAt,
  };
}

/** A demo with its current state and term, for the owner console's list. */
export interface DemoSummary {
  demoId: string;
  state: DemoState;
  leaseIssuedAt: Date | null;
  leaseEndsAt: Date | null;
  hostname: string | null;
}

/** A register row with its retirement, if any. */
export interface HostnameView {
  label: string;
  demoId: string;
  allocatedAt: Date;
  retiredAt: Date | null;
}

declare const demoIdBrand: unique symbol;

/** A demo's opaque id: a lower-case UUID, validated at the boundary. */
export type DemoId = string & { readonly [demoIdBrand]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A demo id that is not a canonical lower-case UUID. */
export class InvalidDemoIdError extends Error {
  constructor() {
    super('demo id is not a UUID');
    this.name = 'InvalidDemoIdError';
  }
}

export function parseDemoId(value: string): DemoId {
  if (!UUID.test(value)) throw new InvalidDemoIdError();
  return value as DemoId;
}

/** A move the transition set does not allow, or that an operation owns and a bare transition may not make. */
export class ForbiddenTransitionError extends Error {
  constructor(
    readonly from: DemoState,
    readonly to: DemoState,
    reason?: string
  ) {
    super(
      `${from} to ${to} is not an allowed transition${reason === undefined ? '' : `: ${reason}`}`
    );
    this.name = 'ForbiddenTransitionError';
  }
}

/** Another transition of the same demo won the race for the next position in its history. */
export class ConcurrentTransitionError extends Error {
  constructor(readonly demoId: string) {
    super(`demo ${demoId} changed state while this transition was being recorded`);
    this.name = 'ConcurrentTransitionError';
  }
}

/** The demo has no history: it was never begun. */
export class UnknownDemoError extends Error {
  constructor(readonly demoId: string) {
    super(`demo ${demoId} does not exist`);
    this.name = 'UnknownDemoError';
  }
}

/** A demo begun twice. */
export class DemoExistsError extends Error {
  constructor(readonly demoId: string) {
    super(`demo ${demoId} already exists`);
    this.name = 'DemoExistsError';
  }
}

/** An extension the rules do not give: the demo is not LIVE or EXPIRING, or its one self-service extension is spent. */
export class ExtensionRefusedError extends Error {
  constructor(
    readonly demoId: string,
    readonly reason: 'state' | 'spent'
  ) {
    super(
      reason === 'state'
        ? `demo ${demoId} can be extended only while LIVE or EXPIRING`
        : `demo ${demoId} has used its one self-service extension`
    );
    this.name = 'ExtensionRefusedError';
  }
}

/** The label is already in the register, allocated or retired: a hostname is never given twice. */
export class HostnameReusedError extends Error {
  constructor(readonly label: string) {
    super('that hostname is already in the register');
    this.name = 'HostnameReusedError';
  }
}

/** A second hostname for a demo that already has its one. */
export class DemoHostnameExistsError extends Error {
  constructor(readonly demoId: string) {
    super(`demo ${demoId} already has its hostname`);
    this.name = 'DemoHostnameExistsError';
  }
}

/** A hostname is allocated while the demo is CLAIMED, before its descriptor is signed, and not otherwise. */
export class HostnameAllocationRefusedError extends Error {
  constructor(
    readonly demoId: string,
    readonly state: DemoState
  ) {
    super(`demo ${demoId} is ${state}: a hostname is allocated while a demo is CLAIMED`);
    this.name = 'HostnameAllocationRefusedError';
  }
}

/** Retirement of a label that is not in the register. */
export class UnknownHostnameError extends Error {
  constructor(readonly label: string) {
    super('that hostname is not in the register');
    this.name = 'UnknownHostnameError';
  }
}

/** Retirement of a label that is already retired. */
export class HostnameRetiredError extends Error {
  constructor(readonly label: string) {
    super('that hostname is already retired');
    this.name = 'HostnameRetiredError';
  }
}

/** Where a demo stands, as far as the transition rules need. */
export interface DemoPosition {
  state: DemoState;
  /** The state the latest event was made from; for PROMOTING, the state a failed promotion returns to. */
  origin: DemoState | null;
}

/**
 * Refuses a transition the closed set does not hold. Two rules the set cannot
 * state: a move into EXTENDED from LIVE or EXPIRING is `extend`'s, because it
 * moves the term, and a promotion that does not complete returns to the state
 * it came from.
 *
 * @throws ForbiddenTransitionError
 */
export function assertTransitionAllowed(position: DemoPosition, to: DemoState): void {
  const { state, origin } = position;
  if (!isAllowedTransition(state, to)) throw new ForbiddenTransitionError(state, to);
  if (to === 'EXTENDED' && state !== 'PROMOTING') {
    throw new ForbiddenTransitionError(state, to, 'an extension moves the term: use extend');
  }
  if (state === 'PROMOTING' && to !== 'PROMOTED' && to !== origin && !isSafetyExit(to)) {
    throw new ForbiddenTransitionError(state, to, `a promotion returns to ${origin}`);
  }
}

function isSafetyExit(to: DemoState): boolean {
  return to === 'KILLED' || to === 'FROZEN';
}

/**
 * Refuses an extension outside LIVE or EXPIRING, and a second self-service one.
 *
 * @throws ExtensionRefusedError
 */
export function assertExtensionAllowed(
  demoId: string,
  state: DemoState,
  extensionsTaken: number
): void {
  if (state !== 'LIVE' && state !== 'EXPIRING') throw new ExtensionRefusedError(demoId, 'state');
  if (extensionsTaken > 0) throw new ExtensionRefusedError(demoId, 'spent');
}

/**
 * A new hostname label: 20 characters of base32 from the operating system's
 * random source. It takes nothing from the demo, the prospect or the slot.
 * `random` is the seam for a test. The low five bits of a byte choose the
 * letter, so each of the 32 letters is equally likely.
 */
export function generateLabel(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(LABEL_LENGTH);
  let label = '';
  for (const byte of bytes) label += LABEL_ALPHABET.charAt(byte & LABEL_LETTER_MASK);
  return label;
}
