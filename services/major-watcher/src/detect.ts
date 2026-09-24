import { parseGhostTag } from './semver.js';
import type { GhostRelease } from './ghostReleases.js';

// The dedupe state this watcher persists between runs. `lastNotifiedMajor`
// is never optional and never null once a watcher deployment has been
// bootstrapped -- see state.ts for why a missing/malformed state file is a
// hard error rather than a default, and README.md for the seeded value
// this repo ships with.
export interface WatcherState {
  readonly lastNotifiedMajor: number;
}

export interface DecideResult {
  readonly shouldNotify: boolean;
  /** Present only when shouldNotify is true. */
  readonly title?: string;
  readonly message?: string;
  readonly nextState: WatcherState;
}

/**
 * Pure decision: does the release list contain a major line higher than
 * the one already notified about, and if so what should the page say.
 *
 * Fires at most once per major line, on whichever release of that line was
 * published earliest -- a preview (alpha/beta/rc) if TryGhost shipped one,
 * the GA itself otherwise. A later release of the *same* major (another
 * preview, the GA once a preview already fired, or any minor/patch within
 * it) changes nothing: the line was already announced.
 */
export function decide(releases: readonly GhostRelease[], state: WatcherState): DecideResult {
  const parsed = releases
    .filter((r) => !r.draft)
    .map((r) => {
      const tag = parseGhostTag(r.tagName);
      return tag ? { ...r, ...tag } : null;
    })
    .filter((r): r is GhostRelease & ReturnType<typeof parseGhostTag> & object => r !== null);

  if (parsed.length === 0) {
    return { shouldNotify: false, nextState: state };
  }

  const highestMajor = parsed.reduce((max, r) => Math.max(max, r.major), 0);

  if (highestMajor <= state.lastNotifiedMajor) {
    return { shouldNotify: false, nextState: state };
  }

  const candidates = parsed.filter((r) => r.major === highestMajor);
  const earliest = candidates.reduce((first, r) => (r.publishedAt < first.publishedAt ? r : first));

  const title = `Ghost ${highestMajor}.0.0`;
  const message = earliest.prerelease
    ? `Public preview of Ghost ${highestMajor}.0.0 announced upstream: ${earliest.tagName}, published ${earliest.publishedAt}. https://github.com/TryGhost/Ghost/releases/tag/${earliest.tagName}`
    : `Ghost ${highestMajor}.0.0 announced upstream: ${earliest.tagName}, published ${earliest.publishedAt}. https://github.com/TryGhost/Ghost/releases/tag/${earliest.tagName}`;

  return {
    shouldNotify: true,
    title,
    message,
    nextState: { lastNotifiedMajor: highestMajor },
  };
}
