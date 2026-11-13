import type { MailRoute } from './descriptorTargets.js';

/** Where the collector submits a message: the estate's own mail host, or the external relay. */
export type SendingTarget = MailRoute;

/**
 * `transactional` is mail a member is waiting on (sign-in links); `bulk` is a
 * newsletter. The wire says which: `emailId` is null for the former.
 */
export type MailClass = 'transactional' | 'bulk';

/**
 * How a submission to a target failed, as the target's own client reports it.
 * `not-accepted` is a definite non-acceptance: nothing was taken (connection
 * refused, DNS failure, authentication failure, a 4xx at MAIL or RCPT).
 * `recipient-rejected` is a recipient 5xx (a bad address is bad everywhere).
 * `ambiguous` is anything that may have been accepted (a timeout after DATA)
 * and anything a client did not classify.
 */
export type SubmissionFailureKind = 'not-accepted' | 'recipient-rejected' | 'ambiguous';

/** Thrown by a delivery client that can name its failure. Any other error counts as `ambiguous`. */
export class TargetSubmissionError extends Error {
  constructor(
    message: string,
    readonly kind: SubmissionFailureKind
  ) {
    super(message);
    this.name = 'TargetSubmissionError';
  }
}

export function failureKindOf(error: unknown): SubmissionFailureKind {
  return error instanceof TargetSubmissionError ? error.kind : 'ambiguous';
}

/** The one place a message's class is decided from the wire. */
export function mailClassOf(emailId: string | null): MailClass {
  return emailId === null ? 'transactional' : 'bulk';
}

/**
 * The only edges that exist: after a failure at the key, the targets that may
 * be tried next. There is no edge out of mx1, and nothing in the route
 * configuration can add one. See ../README.md#sendingtarget-resolvesendingtarget.
 */
export const FALLBACK_EDGES: Readonly<Record<SendingTarget, readonly SendingTarget[]>> = {
  sweego: ['mx1'],
  mx1: [],
};

/** What the collector knows of Sweego use. No counter exists yet; see ../README.md#sendingtarget-resolvesendingtarget. */
export interface SweegoQuota {
  allowanceReached(targetId: string): boolean;
  accountCapReached(): boolean;
  /** The account total reached the newsletter threshold. Absent: no separate threshold. */
  newsletterThresholdReached?(): boolean;
  /** Sweego is latched off: by a run of refusals, or by the owner. Absent: never suspended. */
  suspended?(): boolean;
}

/**
 * Used when no quota is supplied: with nothing counting Sweego use, the
 * allowance cannot be shown to remain, so it is treated as reached and a
 * Sweego route is served by mx1 (never Sweego unless the rules say so).
 */
export const QUOTA_UNKNOWN: SweegoQuota = {
  allowanceReached: () => true,
  accountCapReached: () => true,
};

export interface SendingContext {
  mailClass: MailClass;
  /** True for a demo host: it only ever sends through mx1. */
  demo: boolean;
  /** False while the process holds no Sweego delivery client. */
  sweegoConfigured: boolean;
  /** The tenant's Sweego allowance for the period is used up: its sign-in links and its newsletters both move. */
  allowanceReached: boolean;
  /** The account-wide Sweego cap is reached. */
  accountCapReached: boolean;
  /** The account total reached the newsletter threshold: every tenant's newsletters move, sign-in links stay. Unset: not reached. */
  newsletterThresholdReached?: boolean;
  /** Sweego is latched off. Unset: not suspended. */
  suspended?: boolean;
  /** An attempt for this message id already reached mx1, in this offer or an earlier one. */
  reachedMx1: boolean;
  /** Set when an attempt for this offer just failed. */
  failed?: { target: SendingTarget; kind: SubmissionFailureKind };
}

/** What to do with the message now: send it to a target, or leave it unacked so the shim re-offers it. */
export type SendingDecision = SendingTarget | 'hold';

/**
 * Thrown if a decision would put Sweego after mx1. Never expected: the rules
 * below cannot produce it, this is the last guard.
 */
export class SweegoAfterMx1Error extends Error {
  constructor() {
    super('refusing to send through sweego after an attempt reached mx1');
    this.name = 'SweegoAfterMx1Error';
  }
}

export function assertNoSweegoAfterMx1(reachedMx1: boolean, decision: SendingDecision): void {
  if (reachedMx1 && decision === 'sweego') {
    throw new SweegoAfterMx1Error();
  }
}

function afterFailure(
  mailClass: MailClass,
  failed: { target: SendingTarget; kind: SubmissionFailureKind }
): SendingDecision {
  const next = FALLBACK_EDGES[failed.target][0];
  if (next === undefined) {
    return 'hold';
  }
  return mailClass === 'transactional' && failed.kind === 'not-accepted' ? next : 'hold';
}

function decide(route: MailRoute, ctx: SendingContext): SendingDecision {
  if (ctx.failed !== undefined) {
    return afterFailure(ctx.mailClass, ctx.failed);
  }
  // Anything that is not exactly 'sweego' is mx1: the conservative reading.
  if (route !== 'sweego' || ctx.demo || ctx.reachedMx1) {
    return 'mx1';
  }
  if (!ctx.sweegoConfigured || ctx.suspended === true || ctx.accountCapReached) {
    return 'mx1';
  }
  if (
    ctx.mailClass === 'bulk' &&
    (ctx.allowanceReached || ctx.newsletterThresholdReached === true)
  ) {
    return 'mx1';
  }
  if (ctx.mailClass === 'transactional' && ctx.allowanceReached) {
    return 'mx1';
  }
  return 'sweego';
}

/**
 * Pure. Which target the message goes to, or `hold`. Hard rules, in order:
 * after a failure, only the one edge in FALLBACK_EDGES, taken by transactional
 * mail after a definite non-acceptance and by nothing else; mx1 for an mx1
 * route and for a demo; never Sweego once mx1 was reached; mx1 when Sweego is
 * unset, suspended or at the account cap, for every class; a newsletter goes
 * to mx1 when its tenant is latched or the newsletter threshold is reached; a
 * sign-in link goes to mx1 when its tenant is latched; otherwise Sweego.
 */
export function resolveSendingTarget(route: MailRoute, ctx: SendingContext): SendingDecision {
  const decision = decide(route, ctx);
  assertNoSweegoAfterMx1(ctx.reachedMx1 || ctx.failed?.target === 'mx1', decision);
  return decision;
}
