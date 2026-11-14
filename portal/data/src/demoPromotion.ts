import { assertTransitionAllowed, type DemoPosition, type DemoState } from './demoLifecycle.js';

/**
 * The fields a promotion must supply by name. Each is tier-differentiated, so
 * none has a default and none is carried over from the demo; a field left out
 * is refused by its name. The list mirrors the render core's promotion
 * targets plus the code-injection setting.
 */
export const PROMOTION_TARGET_FIELDS = [
  'databaseHost',
  'databasePort',
  'mediaEndpoint',
  'mediaRegion',
  'mediaResize',
  'mediaSrcsets',
  'backupEncryptionRecipient',
  'limits',
  'mailIdentity',
  'mailEnabled',
  'mailCeiling',
  'mailEstateCeiling',
  'codeInjection',
] as const;
export type PromotionTargetField = (typeof PROMOTION_TARGET_FIELDS)[number];

/** What the caller supplies; presence is checked here, shape by the render core. */
export type PromotionTargets = Readonly<Partial<Record<PromotionTargetField, unknown>>>;

/** A recorded fact the promotion rests on: what it is and when it was recorded. */
export interface PromotionEvidence {
  reference: string;
  recordedAt: Date;
}

/** The finished export bundle of the demo's content, taken drained under a consented grant. */
export interface ExportEvidence extends PromotionEvidence {
  archiveReference: string;
}

/** The three go/no-go answers a gate can give; only PROMOTE lets the swap begin. */
export type GateVerdict = 'PROMOTE' | 'WAIT' | 'ABANDON';

export interface ContentVerification {
  postPresent: boolean;
  memberPresent: boolean;
  imagePresent: boolean;
}

export interface DumpReceipt {
  reference: string;
  takenAt: Date;
}

/** Every outside action the promotion takes. Nothing in this module touches a host or a database. */
export interface PromotionEffects {
  /** Whether the demo's drain flag is set. An unreadable flag answers true or throws, never false. */
  isDrained(demoId: string): Promise<boolean>;
  gateVerdict(demoId: string): Promise<GateVerdict>;
  /** Records a transition of the demo's state history. */
  transition(demoId: string, to: DemoState): Promise<void>;
  /** Re-points the record to the tenant's descriptor, atomically: it commits whole or not at all. */
  commitSwap(demoId: string, targets: PromotionTargets): Promise<void>;
  /** Puts the record back as it was before `commitSwap`. */
  rollbackSwap(demoId: string): Promise<void>;
  verifyContent(demoId: string): Promise<ContentVerification>;
  /** Takes the tenant's first dump and returns only when it exists. */
  takeFirstDump(demoId: string): Promise<DumpReceipt>;
  /** Leaves PROMOTING for the state it came from, moving the term to at least the notice lead from now. */
  abortPromotion(demoId: string, returnTo: DemoState): Promise<void>;
  /** Retires the demo's hostname with no redirect. */
  retireHostname(demoId: string): Promise<void>;
}

export interface PromotionRequest {
  demoId: string;
  position: DemoPosition;
  approval: PromotionEvidence | null;
  consent: PromotionEvidence | null;
  exportDone: ExportEvidence | null;
  targets: PromotionTargets;
}

export type PromotionPrecondition =
  'approval' | 'consent' | 'export' | 'drain' | 'gate' | 'targets';

/** A precondition did not hold. Nothing was changed: the check runs before the first write. */
export class PromotionRefusedError extends Error {
  constructor(
    readonly precondition: PromotionPrecondition,
    detail: string
  ) {
    super(`promotion refused, ${precondition}: ${detail}`);
    this.name = 'PromotionRefusedError';
  }
}

/** One or more promotion targets were left out; the message names each. */
export class PromotionTargetMissingError extends PromotionRefusedError {
  constructor(readonly fields: readonly PromotionTargetField[]) {
    super('targets', `missing ${fields.join(', ')}`);
    this.name = 'PromotionTargetMissingError';
  }
}

export type PromotionStep = 'swap' | 'content' | 'dump' | 'drain' | 'finish';

export type PromotionOutcome =
  | {
      status: 'promoted';
      dump: DumpReceipt;
      /** False when retiring the hostname failed after the promotion was complete: a follow-up, not a failure. */
      hostnameRetired: boolean;
    }
  | {
      status: 'incomplete';
      failedStep: PromotionStep;
      reason: string;
      /** The demo state it returned to; null when it is still PROMOTING. */
      returnedTo: DemoState | null;
      /** True when the swap had been committed and was put back. */
      swapRolledBack: boolean;
    };

/** The targets left out: undefined, null or an empty string. A false or a zero is an answer. */
function missingTargets(targets: PromotionTargets): PromotionTargetField[] {
  return PROMOTION_TARGET_FIELDS.filter((field) => {
    const value = targets[field];
    return value === undefined || value === null || value === '';
  });
}

/**
 * Refuses unless every precondition holds, before any write. The order is
 * state, approval, consent, targets, export, drain, gate.
 *
 * @throws ForbiddenTransitionError
 * @throws PromotionRefusedError
 */
async function assertPreconditions(
  request: PromotionRequest,
  effects: PromotionEffects
): Promise<void> {
  assertTransitionAllowed(request.position, 'PROMOTING');
  if (request.approval === null) {
    throw new PromotionRefusedError('approval', 'no recorded approval');
  }
  if (request.consent === null) {
    throw new PromotionRefusedError('consent', 'no recorded consent');
  }
  const missing = missingTargets(request.targets);
  if (missing.length > 0) throw new PromotionTargetMissingError(missing);
  if (request.exportDone === null || request.exportDone.archiveReference === '') {
    throw new PromotionRefusedError('export', 'the export of the demo content is not done');
  }
  if (!(await effects.isDrained(request.demoId))) {
    throw new PromotionRefusedError('drain', 'the demo is not drained');
  }
  const verdict = await effects.gateVerdict(request.demoId);
  if (verdict !== 'PROMOTE') {
    throw new PromotionRefusedError('gate', `the gate answered ${verdict}`);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown failure';
}

function contentIsVerified(found: ContentVerification): boolean {
  return found.postPresent && found.memberPresent && found.imagePresent;
}

function dumpExists(receipt: DumpReceipt | undefined): receipt is DumpReceipt {
  return receipt !== undefined && receipt.reference !== '';
}

/**
 * Promotes an approved demo: PROMOTING, the swap, the content check, the first
 * dump, then PROMOTED. A refusal leaves everything as it was. A failure after
 * PROMOTING puts the swap back and returns the demo to the state it came from,
 * and the outcome says so: a promotion without a dump is never reported done.
 * If the swap cannot be put back, the demo stays PROMOTING so nothing is
 * purged under a half-promoted record.
 *
 * @throws ForbiddenTransitionError
 * @throws PromotionRefusedError
 */
export async function promoteDemo(
  request: PromotionRequest,
  effects: PromotionEffects
): Promise<PromotionOutcome> {
  await assertPreconditions(request, effects);
  const { demoId } = request;
  await effects.transition(demoId, 'PROMOTING');

  let step: PromotionStep = 'swap';
  let swapCommitted = false;
  try {
    await effects.commitSwap(demoId, request.targets);
    swapCommitted = true;
    step = 'content';
    if (!contentIsVerified(await effects.verifyContent(demoId))) {
      return await abandon(request, effects, step, 'content check failed', swapCommitted);
    }
    step = 'dump';
    const dump = await effects.takeFirstDump(demoId);
    if (!dumpExists(dump)) {
      return await abandon(request, effects, step, 'no first dump', swapCommitted);
    }
    step = 'drain';
    if (!(await effects.isDrained(demoId))) {
      return await abandon(request, effects, step, 'drain lifted', swapCommitted);
    }
    step = 'finish';
    await effects.transition(demoId, 'PROMOTED');
    return { status: 'promoted', dump, hostnameRetired: await retire(demoId, effects) };
  } catch (error) {
    return abandon(request, effects, step, reasonOf(error), swapCommitted);
  }
}

async function retire(demoId: string, effects: PromotionEffects): Promise<boolean> {
  try {
    await effects.retireHostname(demoId);
    return true;
  } catch {
    return false;
  }
}

async function abandon(
  request: PromotionRequest,
  effects: PromotionEffects,
  failedStep: PromotionStep,
  reason: string,
  swapCommitted: boolean
): Promise<PromotionOutcome> {
  const origin = request.position.state;
  let swapRolledBack = false;
  if (swapCommitted) {
    try {
      await effects.rollbackSwap(request.demoId);
      swapRolledBack = true;
    } catch {
      return { status: 'incomplete', failedStep, reason, returnedTo: null, swapRolledBack };
    }
  }
  try {
    await effects.abortPromotion(request.demoId, origin);
  } catch {
    return { status: 'incomplete', failedStep, reason, returnedTo: null, swapRolledBack };
  }
  return { status: 'incomplete', failedStep, reason, returnedTo: origin, swapRolledBack };
}
