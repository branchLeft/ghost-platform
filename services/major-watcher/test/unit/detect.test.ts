import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decide, type WatcherState } from '../../src/detect.js';
import type { GhostRelease } from '../../src/ghostReleases.js';

async function fixture(name: string): Promise<GhostRelease[]> {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as GhostRelease[];
}

describe('decide', () => {
  it('does not notify while the highest major present is already known', async () => {
    const releases = await fixture('pre-major-6.json');
    const state: WatcherState = { lastNotifiedMajor: 5 };
    const result = decide(releases, state);
    expect(result.shouldNotify).toBe(false);
    expect(result.nextState).toEqual(state);
  });

  // The replay proof from #1301's Done criteria: a real recording of Ghost
  // 6.0.0's announcement (its alpha/rc previews through GA, interleaved
  // with unrelated 5.x patch releases exactly as GitHub returns them)
  // fires the watcher exactly once, dated to the *earliest* sighting --
  // the first public preview -- not the eventual GA.
  it('replay: a past major announcement fires exactly once, on its earliest (preview) sighting', async () => {
    const releases = await fixture('major-6-announced.json');
    const firstRun = decide(releases, { lastNotifiedMajor: 5 });

    expect(firstRun.shouldNotify).toBe(true);
    expect(firstRun.title).toBe('Ghost 6.0.0');
    expect(firstRun.message).toContain('Public preview of Ghost 6.0.0');
    expect(firstRun.message).toContain('v6.0.0-alpha.1');
    expect(firstRun.message).toContain('2025-07-16T10:54:47Z');
    expect(firstRun.nextState).toEqual({ lastNotifiedMajor: 6 });

    // Same upstream data polled again (the next scheduled run, state now
    // updated from the first) must not fire a second time.
    const secondRun = decide(releases, firstRun.nextState);
    expect(secondRun.shouldNotify).toBe(false);
    expect(secondRun.nextState).toEqual({ lastNotifiedMajor: 6 });
  });

  it('replay: a minor release within an already-notified major does not fire', async () => {
    const releases = await fixture('minor-only-after-major-6.json');
    const result = decide(releases, { lastNotifiedMajor: 6 });
    expect(result.shouldNotify).toBe(false);
    expect(result.nextState).toEqual({ lastNotifiedMajor: 6 });
  });

  it('excludes draft releases: a draft-only major sighting does not fire', async () => {
    const releases = await fixture('major-7-draft-only.json');
    const result = decide(releases, { lastNotifiedMajor: 6 });
    expect(result.shouldNotify).toBe(false);
  });

  it('fires on the GA itself when no preview preceded it', () => {
    const releases: GhostRelease[] = [
      { tagName: 'v6.65.0', publishedAt: '2026-09-22T15:28:40Z', draft: false },
      { tagName: 'v7.0.0', publishedAt: '2026-10-01T09:00:00Z', draft: false },
    ];
    const result = decide(releases, { lastNotifiedMajor: 6 });
    expect(result.shouldNotify).toBe(true);
    expect(result.message).toContain('Ghost 7.0.0 announced upstream');
    expect(result.message).not.toContain('Public preview');
    expect(result.nextState).toEqual({ lastNotifiedMajor: 7 });
  });

  it('ignores tags that are not plain semver without crashing', () => {
    const releases: GhostRelease[] = [
      { tagName: 'latest', publishedAt: '2026-09-22T15:28:40Z', draft: false },
      { tagName: 'v6.65.0', publishedAt: '2026-09-22T15:28:40Z', draft: false },
    ];
    const result = decide(releases, { lastNotifiedMajor: 6 });
    expect(result.shouldNotify).toBe(false);
  });

  it('returns no-op on an empty release list', () => {
    const result = decide([], { lastNotifiedMajor: 6 });
    expect(result.shouldNotify).toBe(false);
    expect(result.nextState).toEqual({ lastNotifiedMajor: 6 });
  });
});
