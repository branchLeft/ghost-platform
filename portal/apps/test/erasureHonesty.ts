/**
 * What an erasure page may and may not say, as checks over its markup. The
 * page test runs them against the real page and the sabotage test runs them
 * against pages with one rule broken, so the same rule is the one proven.
 */

/** Words that say the data is gone. The placeholders for the page's own copy do not contain them. */
const GONE_WORDS = /DELETED|GONE|REMOVED|COMPLETE|DONE|FINISHED|WIPED|ERASED_AT/;

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

/** The ISO timestamps a page prints. */
export function timestampsIn(html: string): string[] {
  return html.match(ISO_TIME) ?? [];
}

/** What is wrong with a page for a request whose key has not been recorded as destroyed. */
export function problemsBeforeKeyDestroyed(html: string, requestedAt: string): string[] {
  const problems: string[] = [];
  if (!html.includes('ERASURE_STATUS_REQUESTED')) problems.push('does not say it is requested');
  if (!html.includes('ERASURE_NOTHING_ERASED_YET')) problems.push('does not say nothing is erased');
  for (const word of ['ERASURE_STATUS_KEY_DESTROYED', 'RESIDUAL', 'ERASURE_KEY_DESTROYED_AT']) {
    if (html.includes(word)) problems.push(`says ${word} before the key is recorded destroyed`);
  }
  if (GONE_WORDS.test(html)) problems.push('uses a word for the data being gone');
  if (html.includes('ERASURE_REQUEST_BUTTON')) problems.push('still offers the button');
  const times = timestampsIn(html);
  if (times.some((t) => t !== requestedAt)) problems.push('prints a time other than the request');
  return problems;
}

/** What is wrong with a page for a request whose key is recorded as destroyed. */
export function problemsAfterKeyDestroyed(
  html: string,
  requestedAt: string,
  keyDestroyedAt: string
): string[] {
  const problems: string[] = [];
  for (const word of [
    'ERASURE_STATUS_KEY_DESTROYED',
    'ERASURE_RESIDUAL_AROUND_DAYS',
    'ERASURE_RESIDUAL_NO_UPPER_BOUND',
    'ERASURE_RESIDUAL_REASON_ANCHOR_DUMP_NEVER_PRUNED',
  ]) {
    if (!html.includes(word)) problems.push(`does not say ${word}`);
  }
  if (!html.includes('<dd>46</dd>')) problems.push('does not state the figure, 46');
  if (GONE_WORDS.test(html)) problems.push('uses a word for the data being gone');
  if (html.includes('ERASURE_NOTHING_ERASED_YET')) problems.push('still says nothing is erased');
  // No date on which the data is gone: the only moments are the two recorded ones.
  if (timestampsIn(html).some((t) => t !== requestedAt && t !== keyDestroyedAt)) {
    problems.push('prints a date that is neither recorded moment');
  }
  // Nothing claims a bound: no "within", "by", "at most" or "up to" in any placeholder.
  if (/WITHIN|AT_MOST|UP_TO|MAXIMUM|GUARANTEE|BY_DATE|ENDS/.test(html)) {
    problems.push('claims a bound');
  }
  return problems;
}
