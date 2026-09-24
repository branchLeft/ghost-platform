// Parses a Ghost release tag (`v6.0.0`, `v6.0.0-rc.2`, `v6.0.0-alpha.1`)
// into its numeric major/minor/patch and a raw prerelease string.
//
// Deliberately does not trust GitHub's own `prerelease` boolean on the
// release object: a live check against github.com/TryGhost/Ghost's release
// history found v6.0.0-rc.2 flagged `prerelease: false` even though its
// tag plainly carries a `-rc.2` suffix. The tag string is the only field
// that source cannot get wrong about itself.

export interface ParsedTag {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Null for a full release (`v6.0.0`); the raw suffix otherwise (`rc.2`, `alpha.1`, `beta`). */
  readonly prerelease: string | null;
}

const TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Returns null for anything that is not a plain `vMAJOR.MINOR.PATCH[-PRERELEASE]` tag. */
export function parseGhostTag(tagName: string): ParsedTag | null {
  const match = TAG_PATTERN.exec(tagName.trim());
  if (!match) return null;
  const [, majorStr, minorStr, patchStr, prerelease] = match;
  return {
    major: Number(majorStr),
    minor: Number(minorStr),
    patch: Number(patchStr),
    prerelease: prerelease ?? null,
  };
}
