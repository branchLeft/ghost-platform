// How a warned candidate is shown: log lines, one GitHub Actions annotation,
// and job-summary markdown. Every form names the rollback route and what it
// costs, so a reader of any one of them knows the way back.
import { RESTORE_ROUTE } from './proof.mjs';

const COST =
  'rolling back means restoring the pre-upgrade backup: every write since the backup is lost and the site is down during the restore';

/** Plain log lines: a headline, one line per red check, then the route. */
export function warningLines(warnings) {
  return [
    `WARNING: the old image does not work on the data the new image migrated (${warnings.length} rollback check(s) red)`,
    ...warnings.map((w) => `WARNING:   ${w.check}: ${w.detail}`),
    `WARNING: the rollback route for this upgrade is ${RESTORE_ROUTE}: ${COST}`,
  ];
}

/** GitHub escapes data in a workflow command: percent, carriage return, line feed. */
const escapeData = (text) =>
  text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

/** One `::warning` workflow command: a log annotation on the run. */
export function annotation(warnings) {
  const body = warningLines(warnings).join('\n');
  return `::warning title=${escapeData(`Rollback route is ${RESTORE_ROUTE}`)}::${escapeData(body)}`;
}

/** Markdown for the job summary. */
export function summaryMarkdown(warnings) {
  return [
    `### Rollback proof: warning, the rollback route is \`${RESTORE_ROUTE}\``,
    '',
    `The candidate is accepted. The old image does not work on the data it migrated, so ${COST}.`,
    '',
    '| Rollback check | Detail |',
    '| --- | --- |',
    ...warnings.map(
      (w) => `| \`${w.check}\` | ${String(w.detail).replaceAll('|', '\\|').replaceAll('\n', ' ')} |`
    ),
    '',
  ].join('\n');
}
