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
 * The one seam LLD-8 §09's load-bearing mark turns on: "the reported
 * version is read from the undrained colour" is not a convention a
 * consumer has to remember to apply correctly -- it is enforced here, once,
 * by simply not producing a `reported` value at all for a drained colour.
 *
 * That is also the story's control case. A caller that reads
 * `rawReported` directly instead of this function's `reported` -- "answer
 * with whichever colour responds first" -- reintroduces exactly the bug
 * this exists to prevent: during a legitimate overlap, the retiring
 * colour's real (and, correctly, mismatching) version leaks through and
 * gets read as a stuck tenant.
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
