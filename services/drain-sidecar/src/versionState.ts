export interface VersionState {
  /** What the descriptor intends, or `null` if that isn't known here yet. */
  readonly intended: string | null;
  /**
   * What this colour's Ghost actually reports -- but only when this colour
   * is undrained. `null` on a drained colour is not "we couldn't read it";
   * it is "this colour is not the one whose version answers the question",
   * by construction, in the one place that decides it.
   */
  readonly reported: string | null;
  /**
   * `null` whenever `reported` is null (drained, or the probe came back
   * empty) or `intended` is unknown. Never computed from a drained read.
   */
  readonly matches: boolean | null;
}

/**
 * The one seam that enforces "the reported version is read from the
 * undrained colour" by simply not producing a `reported` value at all for
 * a drained colour. See ../README.md#get-metrics--per-tenant-health-and-version.
 */
export function deriveVersionState(params: {
  intended: string | null;
  rawReported: string | null;
  drained: boolean;
}): VersionState {
  const { intended, rawReported, drained } = params;
  const reported = drained ? null : rawReported;
  const matches = reported === null || intended === null ? null : intended === reported;
  return { intended, reported, matches };
}
