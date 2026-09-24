import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/check.js';
import type { GhostRelease } from '../../src/ghostReleases.js';

const MAJOR_6_RELEASES: GhostRelease[] = [
  { tagName: 'v5.130.6', publishedAt: '2026-01-08T12:41:13Z', draft: false },
  { tagName: 'v6.0.0-alpha.1', publishedAt: '2025-07-16T10:54:47Z', draft: false },
  { tagName: 'v6.0.0', publishedAt: '2025-08-04T05:41:24Z', draft: false },
];

const MINOR_ONLY_RELEASES: GhostRelease[] = [
  { tagName: 'v6.65.0', publishedAt: '2026-09-22T15:28:40Z', draft: false },
];

describe('run (end to end, network and ntfy both faked)', () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'major-watcher-run-'));
    statePath = join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('pages ntfy exactly once for a newly announced major and persists the new state to disk', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const publishNtfy = vi.fn().mockResolvedValue(undefined);

    const result = await run({
      statePath,
      ntfy: { url: 'https://ntfy.example/topic' },
      fetchReleases: async () => MAJOR_6_RELEASES,
      publishNtfy,
    });

    expect(result.notified).toBe(true);
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    const [, msg] = publishNtfy.mock.calls[0] as [unknown, { title: string; message: string }];
    expect(msg.title).toBe('Ghost 6.0.0');
    expect(msg.message).toContain('v6.0.0-alpha.1');

    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      lastNotifiedMajor: number;
    };
    expect(persisted.lastNotifiedMajor).toBe(6);
  });

  it('replay: running twice in sequence against the same upstream data pages exactly once', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const publishNtfy = vi.fn().mockResolvedValue(undefined);
    const opts = {
      statePath,
      ntfy: { url: 'https://ntfy.example/topic' },
      fetchReleases: async () => MAJOR_6_RELEASES,
      publishNtfy,
    };

    const first = await run(opts);
    const second = await run(opts); // simulates the next scheduled run, state now persisted from the first

    expect(first.notified).toBe(true);
    expect(second.notified).toBe(false);
    expect(publishNtfy).toHaveBeenCalledTimes(1);
  });

  it('does not page and does not rewrite state for a minor release', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 6 }));
    const publishNtfy = vi.fn().mockResolvedValue(undefined);
    const before = await readFile(statePath, 'utf8');

    const result = await run({
      statePath,
      ntfy: { url: 'https://ntfy.example/topic' },
      fetchReleases: async () => MINOR_ONLY_RELEASES,
      publishNtfy,
    });

    expect(result.notified).toBe(false);
    expect(publishNtfy).not.toHaveBeenCalled();
    expect(await readFile(statePath, 'utf8')).toBe(before);
  });

  it('propagates a state read failure rather than silently notifying', async () => {
    const publishNtfy = vi.fn().mockResolvedValue(undefined);
    await expect(
      run({
        statePath: join(dir, 'never-written.json'),
        ntfy: { url: 'https://ntfy.example/topic' },
        fetchReleases: async () => MAJOR_6_RELEASES,
        publishNtfy,
      })
    ).rejects.toThrow(/no dedupe state/);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('falls back to the real fetchGhostReleases and publish when neither is injected', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 6 }));
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () =>
        MINOR_ONLY_RELEASES.map((r) => ({
          tag_name: r.tagName,
          published_at: r.publishedAt,
          draft: r.draft,
        })),
    });
    vi.stubGlobal('fetch', globalFetch);
    try {
      const result = await run({ statePath, ntfy: { url: 'https://ntfy.example/topic' } });
      expect(result.notified).toBe(false);
      // The GitHub releases fetch happened for real; ntfy's own fetch is
      // never reached because a minor release never calls publish.
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('propagates an ntfy publish failure and leaves state unwritten, so the next run retries', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const before = await readFile(statePath, 'utf8');
    const publishNtfy = vi
      .fn()
      .mockRejectedValue(new Error('ntfy publish failed: 500 Internal Server Error'));

    await expect(
      run({
        statePath,
        ntfy: { url: 'https://ntfy.example/topic' },
        fetchReleases: async () => MAJOR_6_RELEASES,
        publishNtfy,
      })
    ).rejects.toThrow(/ntfy publish failed/);

    expect(await readFile(statePath, 'utf8')).toBe(before);
  });
});
