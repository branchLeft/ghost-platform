import type { documentAcceptance, documentVersion } from './schema.js';
import type { AcceptableKind, DocumentKind, SubprocessorEntry } from './schema.js';

export { ACCEPTABLE_KINDS, DOCUMENT_KINDS } from './schema.js';
export type { AcceptableKind, DocumentKind, SubprocessorEntry } from './schema.js';

/**
 * The shortest notice, in days, before a new sub-processor list version goes
 * live. PLACEHOLDER: the real period is the owner's to rule, and the table
 * only refuses a notice of less than one day.
 */
export const SUBPROCESSOR_NOTICE_DAYS = 30;

/** A published version as the portals show it. */
export interface DocumentView {
  kind: DocumentKind;
  version: number;
  title: string;
  body: string;
  entries: SubprocessorEntry[];
  publishedAt: Date;
  effectiveAt: Date;
  noticeDays: number;
}

/** What a tenant accepted: the acceptance and the immutable version it points at. */
export interface AcceptanceView {
  kind: AcceptableKind;
  version: number;
  acceptedBy: string;
  acceptedAt: Date;
  title: string;
  effectiveAt: Date;
}

export function deriveDocumentView(row: typeof documentVersion.$inferSelect): DocumentView {
  return {
    kind: row.kind as DocumentKind,
    version: row.version,
    title: row.title,
    body: row.body,
    entries: row.entries,
    publishedAt: row.publishedAt,
    effectiveAt: row.effectiveAt,
    noticeDays: row.noticeDays,
  };
}

export function deriveAcceptanceView(
  acceptance: typeof documentAcceptance.$inferSelect,
  version: typeof documentVersion.$inferSelect
): AcceptanceView {
  return {
    kind: acceptance.kind as AcceptableKind,
    version: acceptance.version,
    acceptedBy: acceptance.acceptedBy,
    acceptedAt: acceptance.acceptedAt,
    title: version.title,
    effectiveAt: version.effectiveAt,
  };
}

/** Acceptance of a version that is not the current one for its kind. */
export class NotCurrentVersionError extends Error {
  constructor(
    readonly kind: string,
    readonly version: number
  ) {
    super(`${kind} version ${version} is not the current version`);
    this.name = 'NotCurrentVersionError';
  }
}

/** The gate: a tenant has not accepted the current version of every document it must. */
export class TermsNotAcceptedError extends Error {
  constructor(readonly pending: readonly DocumentView[]) {
    super(`not accepted: ${pending.map((d) => `${d.kind} v${d.version}`).join(', ')}`);
    this.name = 'TermsNotAcceptedError';
  }
}

/** A publication the notice rule or the version rule refuses. */
export class InvalidPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPublicationError';
  }
}
