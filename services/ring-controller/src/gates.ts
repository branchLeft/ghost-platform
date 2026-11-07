export interface GateResult {
  name: string;
  ok: boolean;
}

/** What the gates ran against, and what they found. The digest is the one the gates were run on. */
export interface GateReport {
  digest: string;
  results: readonly GateResult[];
}

/** The release the gates must have been run for. */
export interface GateSubject {
  digest: string;
}

export type GateVerdict =
  { ok: true } | { ok: false; reason: 'gate-red' | 'gate-digest-mismatch'; detail: string };

/**
 * Pure. Green only when the report is for exactly the release's digest and
 * has at least one result, every one `ok`. Zero gates is not green; a
 * report for any other digest is not green whatever it says.
 */
export function assertGatesGreen(report: GateReport, release: GateSubject): GateVerdict {
  if (release.digest.length === 0 || report.digest !== release.digest) {
    return {
      ok: false,
      reason: 'gate-digest-mismatch',
      detail: 'the gate report is not for the release digest',
    };
  }
  if (report.results.length === 0) {
    return { ok: false, reason: 'gate-red', detail: 'the gate report holds no results' };
  }
  const red = report.results.filter((result) => result.ok !== true).map((result) => result.name);
  if (red.length > 0) {
    return { ok: false, reason: 'gate-red', detail: `red gates: ${red.join(', ')}` };
  }
  return { ok: true };
}
