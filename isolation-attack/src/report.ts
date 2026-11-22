// The dated report: a run's result file turned into the dated note the cookie
// isolation design pages carry. Pure: the same result always renders the same
// bytes, and the date is the run's own finish time, never read from a clock here.
// The design pages live in a separate repository, so this module writes a
// fragment to paste there and does not know where it will go.

import type { CaseResult, ImageRecord, RunResult } from './model.ts';
import { CASE_IDS } from './model.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class ReportError extends Error {}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** `2026-11-19` from a UTC timestamp the run wrote. */
export function isoDateOf(timestamp: string): string {
  const match = ISO.exec(timestamp);
  if (match === null) throw new ReportError('finishedAt is not a UTC timestamp');
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** `19 Nov 2026` from a UTC timestamp the run wrote. */
export function proseDateOf(timestamp: string): string {
  const match = ISO.exec(timestamp);
  if (match === null) throw new ReportError('finishedAt is not a UTC timestamp');
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) throw new ReportError('finishedAt has no such month');
  return `${Number(match[3])} ${month} ${match[1]}`;
}

export function reportFileName(result: RunResult): string {
  return `${isoDateOf(result.finishedAt)}-cookie-isolation-attack-${result.target.kind}.html`;
}

/** Throws unless the result covers every case exactly once, so a report cannot omit one. */
export function assertComplete(result: RunResult): void {
  const seen = result.cases.map((c) => c.id);
  for (const id of CASE_IDS) {
    const count = seen.filter((s) => s === id).length;
    if (count !== 1) throw new ReportError(`case ${id} appears ${count} times, wanted once`);
  }
  if (seen.length !== CASE_IDS.length) throw new ReportError('the result carries an unknown case');
}

function verdictCell(c: CaseResult): string {
  const label =
    c.verdict === 'held' ? 'Held' : c.verdict === 'breached' ? 'Breached' : 'Not exercised';
  const klass = c.verdict === 'held' ? 'ok' : 'bad';
  return `<td class="${klass}">${label}</td>`;
}

function sabotageCell(c: CaseResult): string {
  if (c.sabotage === null) return '<td>Not run against this target</td>';
  const text = c.sabotage.wentRed
    ? `Red as required (${c.sabotage.mode})`
    : `Did not go red (${c.sabotage.mode}): the case cannot see this control`;
  return `<td class="${c.sabotage.wentRed ? 'ok' : 'bad'}">${escapeHtml(text)}</td>`;
}

function evidenceCell(c: CaseResult): string {
  const lines = c.vectors.map(
    (v) => `<li><code>${escapeHtml(v.vector)}</code>: ${escapeHtml(v.evidence)}</li>`
  );
  const residual =
    c.residual === undefined
      ? ''
      : `<p><b>Residual (${escapeHtml(c.residual.status)}).</b> ${escapeHtml(c.residual.detail)}</p>`;
  return `<td><p>${escapeHtml(c.summary)}</p><ul>${lines.join('')}</ul>${residual}</td>`;
}

const SOURCE_TEXT: Record<ImageRecord['source'], string> = {
  inspected: 'read from the Docker daemon',
  pinned: 'pinned by digest in the Dockerfile',
  supplied: 'supplied by the operator',
};

function imageRow(image: ImageRecord): string {
  const digests =
    image.repoDigests.length > 0
      ? image.repoDigests.map((d) => `<code>${escapeHtml(d)}</code>`).join('<br>')
      : 'none (built locally)';
  return (
    '<tr>' +
    `<td>${escapeHtml(image.role)}</td>` +
    `<td><code>${escapeHtml(image.reference)}</code></td>` +
    `<td>${image.imageId === null ? 'not read' : `<code>${escapeHtml(image.imageId)}</code>`}</td>` +
    `<td>${digests}</td>` +
    `<td>${SOURCE_TEXT[image.source]}</td>` +
    '</tr>'
  );
}

export function summaryLine(result: RunResult): string {
  const held = result.cases.filter((c) => c.verdict === 'held').map((c) => c.id);
  const breached = result.cases.filter((c) => c.verdict === 'breached').map((c) => c.id);
  const notRun = result.cases.filter((c) => c.verdict === 'not-exercised').map((c) => c.id);
  const parts = [`${held.length} of ${result.cases.length} cases held`];
  if (breached.length > 0) parts.push(`breached: ${breached.join(', ')}`);
  if (notRun.length > 0) parts.push(`not exercised: ${notRun.join(', ')}`);
  return parts.join('; ');
}

/** True only when every case held and every sabotage that was run went red. */
export function suitePassed(result: RunResult): boolean {
  return result.cases.every(
    (c) => c.verdict === 'held' && (c.sabotage === null || c.sabotage.wentRed)
  );
}

export function renderReport(result: RunResult): string {
  assertComplete(result);
  const date = proseDateOf(result.finishedAt);
  const t = result.target;
  const where =
    t.kind === 'local-rig'
      ? 'two disposable local tenants behind one edge, with the shared parent domain standing in for the production one'
      : 'the deployed shared domain';
  const psl =
    t.psl === 'present'
      ? 'The Public Suffix List entry for the shared domain is stated to be in place.'
      : 'The Public Suffix List entry for the shared domain is not in place.';

  const rows = result.cases
    .map(
      (c) =>
        '<tr>' +
        `<td>${escapeHtml(c.title)}</td>` +
        `<td>${escapeHtml(c.control)}</td>` +
        verdictCell(c) +
        sabotageCell(c) +
        evidenceCell(c) +
        '</tr>'
    )
    .join('\n      ');

  return [
    `<p><b>Dated note, ${escapeHtml(date)}.</b> The targeted tenant-isolation attack suite ran against ${escapeHtml(where)}: ${escapeHtml(summaryLine(result))}. ${escapeHtml(psl)} Tenants: <code>${escapeHtml(t.tenantHosts[0])}</code> (victim) and <code>${escapeHtml(t.tenantHosts[1])}</code> (attacker); portal: <code>${escapeHtml(t.portalHost)}</code>.</p>`,
    '<table>',
    '  <thead>',
    '    <tr><th>Case</th><th>Control under test</th><th>Verdict</th><th>Control switched off</th><th>What was seen</th></tr>',
    '  </thead>',
    '  <tbody>',
    `      ${rows}`,
    '  </tbody>',
    '</table>',
    '<table>',
    '  <thead>',
    '    <tr><th>Image</th><th>Reference</th><th>Image id</th><th>Registry digests</th><th>Source</th></tr>',
    '  </thead>',
    '  <tbody>',
    `      ${result.images.map(imageRow).join('\n      ')}`,
    '  </tbody>',
    '</table>',
    `<p>Browser: ${escapeHtml(result.browser.name)} ${escapeHtml(result.browser.version)}. Suite revision: <code>${escapeHtml(result.revision ?? 'not read')}</code>. Started ${escapeHtml(result.startedAt)}, finished ${escapeHtml(result.finishedAt)}.</p>`,
    '',
  ].join('\n');
}
