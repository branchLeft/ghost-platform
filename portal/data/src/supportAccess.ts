/** What a support-access reading says about a tenant's support account. */
export const SUPPORT_ACCESS_STATES = ['open', 'closed', 'unknown'] as const;
export type SupportAccessState = (typeof SUPPORT_ACCESS_STATES)[number];

/** The two ways a grant is opened; the tenant page does not show which. */
export const SUPPORT_LANES = ['consented', 'incident'] as const;
export type SupportLane = (typeof SUPPORT_LANES)[number];

/**
 * How old a reading may be and still be believed, in seconds. A reading older
 * than this, or dated further ahead than this, is shown as `unknown`: a page
 * that has stopped hearing from a host must never say `closed`. It is a
 * constant, not an option, so no caller can lengthen it.
 */
export const SUPPORT_READING_FRESH_SECONDS = 900;

/** What the collector hands the owner role for one tenant: the read-only report's fields. */
export interface SupportAccessReading {
  readonly state: SupportAccessState;
  readonly lane: SupportLane | null;
  readonly grantedAt: Date | null;
  readonly deadline: Date | null;
}

/** A reading handed to the owner role with a state or lane the table does not know. */
export class InvalidSupportReadingError extends Error {
  constructor() {
    super('the support-access reading names a state or lane outside the closed lists');
    this.name = 'InvalidSupportReadingError';
  }
}

/** Refuses a reading outside the closed lists before it reaches the table. */
export function assertSupportReading(reading: SupportAccessReading): void {
  const stateKnown = (SUPPORT_ACCESS_STATES as readonly string[]).includes(reading.state);
  const laneKnown =
    reading.lane === null || (SUPPORT_LANES as readonly string[]).includes(reading.lane);
  if (!stateKnown || !laneKnown) throw new InvalidSupportReadingError();
}

/** What the tenant page and the console show; the deadline only when the reading is believed. */
export interface SupportAccessView {
  readonly state: SupportAccessState;
  readonly deadline: Date | null;
  /** When the host last reported; null when it never has. */
  readonly observedAt: Date | null;
}

interface StoredReading {
  readonly state: string;
  readonly deadlineAt: Date | null;
  readonly observedAt: Date;
}

const UNKNOWN: SupportAccessView = { state: 'unknown', deadline: null, observedAt: null };

/**
 * A stored reading as it is shown at `now`. No reading, a stale or future-dated
 * one, and a state outside the closed list are all `unknown`; `closed` is
 * returned only when a fresh reading says so.
 */
export function deriveSupportAccessView(row: StoredReading | null, now: Date): SupportAccessView {
  if (row === null) return UNKNOWN;
  const ageSeconds = (now.getTime() - row.observedAt.getTime()) / 1000;
  const unknown: SupportAccessView = { ...UNKNOWN, observedAt: row.observedAt };
  if (Math.abs(ageSeconds) > SUPPORT_READING_FRESH_SECONDS) return unknown;
  if (row.state === 'open') {
    return { state: 'open', deadline: row.deadlineAt, observedAt: row.observedAt };
  }
  if (row.state === 'closed') {
    return { state: 'closed', deadline: null, observedAt: row.observedAt };
  }
  return unknown;
}

/** A tenant's pending request for support access, for the console's queue. */
export interface SupportRequestView {
  readonly tenantId: string;
  readonly requestedAt: Date;
}
