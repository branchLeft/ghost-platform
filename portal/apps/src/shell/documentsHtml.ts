import { escapeHtml } from './html.js';

/** Shown on every document: it is best-effort and has not had professional review. */
export const BEST_EFFORT_MARKING = 'BEST_EFFORT_NOT_PROFESSIONALLY_REVIEWED';

export interface DocumentShown {
  readonly kind: string;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly entries: readonly { readonly name: string; readonly purpose: string }[];
  readonly effectiveAt: Date;
}

export interface AcceptanceShown {
  readonly kind: string;
  readonly version: number;
  readonly acceptedBy: string;
  readonly acceptedAt: Date;
}

const day = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * One document as the tenant portal shows it: its kind, effective version and
 * date, the best-effort marking, and its text and entries, all escaped. A
 * document the tenant has still to accept carries the accept form for exactly
 * that version.
 */
export function renderDocument(document: DocumentShown, pending: boolean): string {
  const entries =
    document.entries.length === 0
      ? ''
      : `<ul>${document.entries
          .map(
            (entry) =>
              `<li><strong>${escapeHtml(entry.name)}</strong> ${escapeHtml(entry.purpose)}</li>`
          )
          .join('')}</ul>`;
  const form = pending
    ? `<form method="post" action="/documents/accept">` +
      `<input type="hidden" name="kind" value="${escapeHtml(document.kind)}">` +
      `<input type="hidden" name="version" value="${document.version}">` +
      `<button type="submit">ACCEPT_THIS_VERSION</button></form>`
    : '';
  return (
    `<section><h2>${escapeHtml(document.title)}</h2>` +
    `<p><strong>${BEST_EFFORT_MARKING}</strong></p>` +
    `<dl><dt>DOCUMENT_KIND</dt><dd>${escapeHtml(document.kind.toUpperCase())}</dd>` +
    `<dt>VERSION</dt><dd>${document.version}</dd>` +
    `<dt>EFFECTIVE</dt><dd><time datetime="${document.effectiveAt.toISOString()}">${day(document.effectiveAt)}</time></dd></dl>` +
    `<p>${escapeHtml(document.body)}</p>${entries}${form}</section>`
  );
}

/** The whole documents page: each document in force, then what the tenant has accepted. */
export function renderDocuments(
  documents: readonly DocumentShown[],
  pending: ReadonlySet<string>,
  accepted: readonly AcceptanceShown[]
): string {
  const key = (kind: string, version: number): string => `${kind}:${version}`;
  const sections =
    documents.length === 0
      ? '<p>NO_DOCUMENTS_IN_FORCE</p>'
      : documents.map((d) => renderDocument(d, pending.has(key(d.kind, d.version)))).join('');
  const history =
    accepted.length === 0
      ? '<p>NOTHING_ACCEPTED_YET</p>'
      : `<ul>${accepted
          .map(
            (a) =>
              `<li>${escapeHtml(a.kind.toUpperCase())} VERSION ${a.version} ACCEPTED_BY ` +
              `${escapeHtml(a.acceptedBy)} ON <time datetime="${a.acceptedAt.toISOString()}">${day(a.acceptedAt)}</time></li>`
          )
          .join('')}</ul>`;
  return `<h1>DOCUMENTS_HEADING</h1>${sections}<h2>ACCEPTED_HEADING</h2>${history}`;
}
