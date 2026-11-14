// Where and when a member list consented. An absent or invalid record never
// passes silently: it sets needsReconfirmation, so the list is re-confirmed.

export const WHERE_MAX_LENGTH = 200;

export type ConsentProblem =
  'absent' | 'invalid-shape' | 'where-empty' | 'where-too-long' | 'when-invalid' | 'when-in-future';

export type ConsentOutcome =
  | { readonly needsReconfirmation: false; readonly where: string; readonly when: string }
  | { readonly needsReconfirmation: true; readonly problem: ConsentProblem };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function reconfirm(problem: ConsentProblem): ConsentOutcome {
  return { needsReconfirmation: true, problem };
}

// `input` is whatever the caller parsed from the consent file; it is untrusted.
export function parseConsentRecord(input: unknown, now: Date): ConsentOutcome {
  if (input === undefined || input === null) {
    return reconfirm('absent');
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return reconfirm('invalid-shape');
  }
  const record = input as { where?: unknown; when?: unknown };
  if (typeof record.where !== 'string') {
    return reconfirm('invalid-shape');
  }
  const where = record.where.trim();
  if (where.length === 0) {
    return reconfirm('where-empty');
  }
  if (where.length > WHERE_MAX_LENGTH) {
    return reconfirm('where-too-long');
  }
  if (typeof record.when !== 'string') {
    return reconfirm('when-invalid');
  }
  const match = ISO_DATE.exec(record.when);
  if (match === null) {
    return reconfirm('when-invalid');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return reconfirm('when-invalid');
  }
  // ISO dates compare correctly as strings.
  if (record.when > now.toISOString().slice(0, 10)) {
    return reconfirm('when-in-future');
  }
  return { needsReconfirmation: false, where, when: record.when };
}
