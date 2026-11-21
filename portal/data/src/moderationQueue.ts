import {
  CLASSIFIER_STATES,
  REFERENCE_PATTERN,
  SUBJECT_KINDS,
  type ItemStatus,
  type StoredClassifier,
  type SubjectKind,
  type moderationItem,
} from './schema.js';

export { ITEM_STATUSES, SUBJECT_KINDS } from './schema.js';
export type { ClassifierState, ItemStatus, StoredClassifier, SubjectKind } from './schema.js';

const REFERENCE = new RegExp(REFERENCE_PATTERN);
const CLASSIFIER_NAME = /^[a-z0-9_]{1,40}$/;

/** A queue item as the portal sees it: references and the decision, never content. */
export interface QueueItemView {
  id: string;
  subjectKind: SubjectKind;
  subjectId: string;
  memberId: string;
  classifiers: StoredClassifier[];
  status: ItemStatus;
  decidedBy: string;
  decidedAt: Date;
}

/** A held classification as the safety service reports it. Untrusted until validated. */
export interface HoldRequest {
  subjectKind: string;
  subjectId: string;
  memberId: string;
  classifiers: readonly StoredClassifier[];
  decidedBy: string;
}

/** A request that would store something other than references and scores. */
export class InvalidQueueItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQueueItemError';
  }
}

function assertReference(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !REFERENCE.test(value)) {
    throw new InvalidQueueItemError(`${label} is not a bounded reference`);
  }
}

/**
 * Refuses anything but references and scores. A classifier is exactly a name,
 * a confidence between 0 and 1 and a floor-or-setting state: an extra key is
 * refused rather than dropped, so a caller cannot carry text in beside them.
 */
export function validateHold(request: HoldRequest): void {
  if (!(SUBJECT_KINDS as readonly string[]).includes(request.subjectKind)) {
    throw new InvalidQueueItemError(`subject kind ${String(request.subjectKind)} is not allowed`);
  }
  assertReference('subject id', request.subjectId);
  assertReference('member id', request.memberId);
  assertReference('decided by', request.decidedBy);
  if (!Array.isArray(request.classifiers) || request.classifiers.length === 0) {
    throw new InvalidQueueItemError('a held item names at least one classifier');
  }
  for (const classifier of request.classifiers) {
    const keys = Object.keys(classifier as object).sort();
    if (keys.join(',') !== 'confidence,name,state') {
      throw new InvalidQueueItemError('a classifier is a name, a confidence and a state only');
    }
    if (typeof classifier.name !== 'string' || !CLASSIFIER_NAME.test(classifier.name)) {
      throw new InvalidQueueItemError('classifier name is not a bounded name');
    }
    if (
      typeof classifier.confidence !== 'number' ||
      !Number.isFinite(classifier.confidence) ||
      classifier.confidence < 0 ||
      classifier.confidence > 1
    ) {
      throw new InvalidQueueItemError('classifier confidence is not between 0 and 1');
    }
    if (!(CLASSIFIER_STATES as readonly string[]).includes(classifier.state)) {
      throw new InvalidQueueItemError('classifier state is not floor or setting');
    }
  }
}

export function deriveQueueItem(row: typeof moderationItem.$inferSelect): QueueItemView {
  return {
    id: row.id,
    subjectKind: row.subjectKind as SubjectKind,
    subjectId: row.subjectId,
    memberId: row.memberId,
    classifiers: row.classifiers.map((c) => ({
      name: c.name,
      confidence: c.confidence,
      state: c.state,
    })),
    status: row.status as ItemStatus,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
  };
}

/** What the portal hands the tenant's Ghost connection to find the subject. */
export interface ContentRef {
  tenantId: string;
  subjectKind: SubjectKind;
  subjectId: string;
  memberId: string;
}

/** The content as the tenant's Ghost holds it right now. Never written back. */
export interface LiveContent {
  text: string;
  memberDisplayName: string;
  postTitle: string;
}

/**
 * The fetch over the connection the safety service already holds to the
 * tenant's own Ghost. It resolves to null only when Ghost says the subject no
 * longer exists; any other failure must reject, so an outage is never shown as
 * deleted content.
 */
export interface ContentSource {
  fetch(ref: ContentRef): Promise<LiveContent | null>;
}

/** An opened item: the stored decision, and the content if Ghost still has it. */
export interface OpenedItem {
  item: QueueItemView;
  content: ({ state: 'present' } & LiveContent) | { state: 'gone' };
}
