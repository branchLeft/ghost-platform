// The signal: github.com/TryGhost/Ghost's own Releases API.
//
// Chosen over the two other signals considered:
//  - npm's `ghost` package dist-tags carry no `prerelease` boolean and no
//    publish timestamp per version without a second round trip, and Ghost's
//    npm publishes lag its GitHub releases.
//  - The Ghost blog/changelog is prose meant for humans; turning "a new
//    major is here" into a reliable machine signal means parsing sentences,
//    not a status code.
//  - GitHub Releases give a structured, versioned, timestamped record of
//    the exact moment TryGhost calls a build ready to announce, including
//    prereleases (alphas/betas/rcs) -- which is what "public preview" means
//    in practice: TryGhost tags and publishes one before every major GA.
//    See semver.ts for why the tag string, not the API's own `prerelease`
//    flag, is what this reads.

export interface GhostRelease {
  readonly tagName: string;
  readonly publishedAt: string;
  readonly draft: boolean;
}

export type FetchLike = typeof fetch;

const RELEASES_URL = 'https://api.github.com/repos/TryGhost/Ghost/releases';

// One page (100, newest-first) is enough for any realistic poll interval:
// Ghost ships roughly weekly, so 100 releases covers well over a year of
// history -- far more than the gap between two scheduled runs of this
// watcher. Going deeper would only add load for no gain in what a
// same-day-or-better poll cadence can ever need to see.
const PER_PAGE = 100;

export interface FetchGhostReleasesOptions {
  readonly fetchImpl?: FetchLike;
  /** Bearer token to raise GitHub's rate limit; the workflow's own ambient GITHUB_TOKEN is enough, no dedicated secret needed. */
  readonly token?: string;
}

export async function fetchGhostReleases(
  options: FetchGhostReleasesOptions = {}
): Promise<GhostRelease[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const res = await fetchImpl(`${RELEASES_URL}?per_page=${PER_PAGE}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub releases fetch failed: ${res.status} ${res.statusText}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) {
    throw new Error('GitHub releases response was not an array');
  }
  return body.map((entry) => {
    const r = entry as { tag_name?: unknown; published_at?: unknown; draft?: unknown };
    if (typeof r.tag_name !== 'string' || typeof r.published_at !== 'string') {
      throw new Error('GitHub release entry missing tag_name or published_at');
    }
    return {
      tagName: r.tag_name,
      publishedAt: r.published_at,
      draft: r.draft === true,
    };
  });
}
