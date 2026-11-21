import {
  DOCUMENT_KINDS,
  InvalidPublicationError,
  type DocumentKind,
  type OwnerDb,
  type SubprocessorEntry,
} from 'ghost-platform-portal-data/owner';
import type { Signed } from '../shell/app.js';
import { escapeHtml, type NavItem } from '../shell/html.js';

type Page = (bound: true, identity: Signed) => Promise<string>;
type Action = (bound: true, identity: Signed, form: URLSearchParams) => Promise<string>;

export interface DocumentsScreen {
  readonly nav: readonly NavItem[];
  readonly pages: Readonly<Record<string, Page>>;
  readonly actions: Readonly<Record<string, Action>>;
  /** The form size the publish action takes, for the shell's per-action limit. */
  readonly formLimits: Readonly<Record<string, number>>;
}

/** What the shell logs when a publish is refused: the name, never the message. */
export class DocumentPublishError extends Error {
  constructor(step: string) {
    super(step);
    this.name = 'DocumentPublishError';
  }
}

export const DOCUMENTS_PATH = '/documents';
export const PUBLISH_PATH = '/documents/publish';
export const PUBLISHED_PATH = '/documents/published';
export const NOT_PUBLISHED_PATH = '/documents/not-published';

/** A pasted document is far larger than the shell's default form: 512 KiB. */
export const PUBLISH_FORM_BYTES = 512 * 1024;
const TITLE_MAX = 200;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const KIND_LABEL: Readonly<Record<DocumentKind, string>> = {
  terms: 'KIND_TERMS',
  usage: 'KIND_USAGE',
  subprocessors: 'KIND_SUBPROCESSORS',
};

/** `YYYY-MM-DD` as midnight UTC; null for anything else, a date that does not exist included. */
export function parseEffectiveDate(value: string): Date | null {
  const match = DATE.exec(value);
  if (match === null) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().startsWith(value) ? date : null;
}

/** One entry a line, `NAME | PURPOSE`; null when any line lacks either part, or there is none. */
export function parseEntries(value: string): SubprocessorEntry[] | null {
  const entries: SubprocessorEntry[] = [];
  for (const line of value.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const at = line.indexOf('|');
    const name = at < 0 ? '' : line.slice(0, at).trim();
    const purpose = at < 0 ? '' : line.slice(at + 1).trim();
    if (name === '' || purpose === '') return null;
    entries.push({ name, purpose });
  }
  return entries.length === 0 ? null : entries;
}

const isKind = (value: string): value is DocumentKind =>
  (DOCUMENT_KINDS as readonly string[]).includes(value);

/**
 * The owner console's one way to publish a version of a document. The text is
 * the owner's, pasted into the form at run time: nothing here holds any.
 *
 * The action runs only for a session whose organisation is the owner's: the
 * console's verifier already admits only that organisation holding the owner
 * role, and this checks again before anything is written, so a session that
 * reached the action by any other road still publishes nothing. The version
 * number and the moment of publication are the database's; the form names
 * neither.
 */
export function createDocumentsScreen(
  db: Pick<OwnerDb, 'publishDocument'>,
  ownerOrgId: string
): DocumentsScreen {
  const form: Page = () => {
    const kinds = DOCUMENT_KINDS.map(
      (kind) => `<option value="${escapeHtml(kind)}">${KIND_LABEL[kind]}</option>`
    ).join('');
    return Promise.resolve(
      `<h1>DOCUMENTS_HEADING</h1><form method="post" action="${PUBLISH_PATH}">` +
        `<p><label>DOCUMENT_KIND <select name="kind">${kinds}</select></label></p>` +
        `<p><label>DOCUMENT_TITLE <input type="text" name="title" maxlength="${TITLE_MAX}" required></label></p>` +
        `<p><label>DOCUMENT_EFFECTIVE_DATE <input type="date" name="effective_date" required></label></p>` +
        `<p><label>DOCUMENT_BODY <textarea name="body" rows="20" cols="80" required></textarea></label></p>` +
        `<p><label>DOCUMENT_ENTRIES <textarea name="entries" rows="6" cols="80"></textarea></label></p>` +
        `<p><button type="submit">PUBLISH</button></p></form>`
    );
  };

  const outcome =
    (line: string): Page =>
    () =>
      Promise.resolve(`<p>${line}</p><p><a href="${DOCUMENTS_PATH}">BACK_TO_DOCUMENTS</a></p>`);

  const publish: Action = async (_bound, identity, fields) => {
    if (identity.orgId !== ownerOrgId) throw new DocumentPublishError('not-owner');
    const kind = fields.get('kind') ?? '';
    const title = (fields.get('title') ?? '').trim();
    const body = fields.get('body') ?? '';
    const effectiveAt = parseEffectiveDate(fields.get('effective_date') ?? '');
    if (!isKind(kind)) return NOT_PUBLISHED_PATH;
    if (title === '' || title.length > TITLE_MAX || body.trim() === '' || effectiveAt === null) {
      return NOT_PUBLISHED_PATH;
    }
    const entries = kind === 'subprocessors' ? parseEntries(fields.get('entries') ?? '') : [];
    if (entries === null) return NOT_PUBLISHED_PATH;
    try {
      await db.publishDocument({
        kind,
        title,
        body,
        effectiveAt,
        ...(kind === 'subprocessors' ? { entries } : {}),
      });
    } catch (error) {
      if (error instanceof InvalidPublicationError) return NOT_PUBLISHED_PATH;
      throw error;
    }
    return PUBLISHED_PATH;
  };

  return {
    nav: [{ label: 'NAV_DOCUMENTS', href: DOCUMENTS_PATH }],
    pages: {
      [DOCUMENTS_PATH]: form,
      [PUBLISHED_PATH]: outcome('DOCUMENT_PUBLISHED'),
      [NOT_PUBLISHED_PATH]: outcome('DOCUMENT_NOT_PUBLISHED'),
    },
    actions: { [PUBLISH_PATH]: publish },
    formLimits: { [PUBLISH_PATH]: PUBLISH_FORM_BYTES },
  };
}
