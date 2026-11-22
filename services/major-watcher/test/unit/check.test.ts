import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { run } from '../../src/check.js';
import type { GhostRelease } from '../../src/ghostReleases.js';
import { fileUpstreamMajor, majorMarker } from '../../src/issues.js';
import { fakeWorkspace, type FakeWorkspace } from './fakeWorkspace.js';

const FILING_CONFIG = { token: 'filing-token-value', launchItem: 3810 };

// The real filer against the in-memory workspace.
function filingAgainst(ws: FakeWorkspace) {
  return {
    filingConfig: () => FILING_CONFIG,
    fileItem: (config: typeof FILING_CONFIG, item: Parameters<typeof fileUpstreamMajor>[1]) =>
      fileUpstreamMajor(config, item, ws.fetch),
  };
}

const MAJOR_6_RELEASES: GhostRelease[] = [
  { tagName: 'v5.130.6', publishedAt: '2026-01-08T12:41:13Z', draft: false },
  { tagName: 'v6.0.0-alpha.1', publishedAt: '2025-07-16T10:54:47Z', draft: false },
  { tagName: 'v6.0.0', publishedAt: '2025-08-04T05:41:24Z', draft: false },
];

const MINOR_ONLY_RELEASES: GhostRelease[] = [
  { tagName: 'v6.65.0', publishedAt: '2026-09-22T15:28:40Z', draft: false },
];

// Behaves like real fetch: rejects with the signal's reason once it aborts, otherwise never settles.
function stallingFetch(): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
  );
}

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
    const ws = fakeWorkspace();

    const result = await run({
      statePath,
      ntfy: { url: 'https://ntfy.example/topic' },
      fetchReleases: async () => MAJOR_6_RELEASES,
      publishNtfy,
      ...filingAgainst(ws),
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

  it('replay: running twice in sequence against the same upstream data pages once and files one labelled item', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const publishNtfy = vi.fn().mockResolvedValue(undefined);
    const ws = fakeWorkspace();
    const opts = {
      statePath,
      ntfy: { url: 'https://ntfy.example/topic' },
      fetchReleases: async () => MAJOR_6_RELEASES,
      publishNtfy,
      ...filingAgainst(ws),
    };

    const first = await run(opts);
    const second = await run(opts); // simulates the next scheduled run, state now persisted from the first

    expect(first.notified).toBe(true);
    expect(second.notified).toBe(false);
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    expect(ws.issues).toHaveLength(1);
    expect(ws.issues[0]?.labels).toContain('upstream-major');
    expect(ws.issues[0]?.body).toContain(majorMarker(6));
    expect(ws.issues[0]?.parent_issue_url).toMatch(/\/issues\/3810$/);
  });

  it('a page that failed after the item was filed is retried without a second item', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const before = await readFile(statePath, 'utf8');
    const ws = fakeWorkspace();
    const opts = {
      statePath,
      ntfy: { url: 'https://ntfy.example/topic' },
      fetchReleases: async () => MAJOR_6_RELEASES,
      ...filingAgainst(ws),
    };

    await expect(
      run({
        ...opts,
        publishNtfy: vi.fn().mockRejectedValue(new Error('ntfy publish failed: 500')),
      })
    ).rejects.toThrow(/ntfy publish failed/);
    expect(await readFile(statePath, 'utf8')).toBe(before);
    expect(ws.issues).toHaveLength(1);

    const retry = await run({ ...opts, publishNtfy: vi.fn().mockResolvedValue(undefined) });

    expect(retry.notified).toBe(true);
    expect(retry.filed?.created).toBe(false);
    expect(ws.issues).toHaveLength(1);
  });

  it('the page names the filed item and carries no filing command', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const publishNtfy = vi.fn().mockResolvedValue(undefined);
    const ws = fakeWorkspace();

    await run({
      statePath,
      ntfy: { url: 'https://ntfy.example/topic' },
      fetchReleases: async () => MAJOR_6_RELEASES,
      publishNtfy,
      ...filingAgainst(ws),
    });

    const [, msg] = publishNtfy.mock.calls[0] as [unknown, { message: string }];
    expect(msg.message).toContain('Tracked item filed under the launch item: https://github.com/');
    expect(msg.message).not.toContain('gh issue create');
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

  it('no filing credential: fails closed (nothing filed), still pages with the by-hand command, fails the run, leaves state unwritten', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const before = await readFile(statePath, 'utf8');
    const publishNtfy = vi.fn().mockResolvedValue(undefined);
    const ws = fakeWorkspace();
    const fileItem = vi.fn();

    await expect(
      run({
        statePath,
        ntfy: { url: 'https://ntfy.example/topic' },
        fetchReleases: async () => MAJOR_6_RELEASES,
        publishNtfy,
        fileItem,
        filingConfig: () => {
          throw new Error(
            'MAJOR_WATCHER_FILING_TOKEN is not set: the filing credential is not placed'
          );
        },
      })
    ).rejects.toThrow(/MAJOR_WATCHER_FILING_TOKEN is not set/);

    expect(fileItem).not.toHaveBeenCalled();
    expect(ws.calls).toHaveLength(0);
    expect(await readFile(statePath, 'utf8')).toBe(before);
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    const [, msg] = publishNtfy.mock.calls[0] as [unknown, { message: string }];
    expect(msg.message).toContain('FILING FAILED, nothing was filed');
    expect(msg.message).toContain('gh issue create');
    expect(msg.message).toContain('--label upstream-major');
    const lines = msg.message.split('\n');
    const commandStart = lines.findIndex((line) => line.startsWith('BODY=$(mktemp)'));
    expect(commandStart).toBeGreaterThan(-1);
    for (const line of lines.slice(commandStart)) {
      expect(line.startsWith('#')).toBe(false);
    }
    // ntfy truncates a message over 4096 bytes into an attachment; the
    // command must arrive whole in the page itself.
    expect(Buffer.byteLength(msg.message, 'utf8')).toBeLessThan(4096);
  });

  it('no filing wiring at all fails closed the same way', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const publishNtfy = vi.fn().mockResolvedValue(undefined);

    await expect(
      run({
        statePath,
        ntfy: { url: 'https://ntfy.example/topic' },
        fetchReleases: async () => MAJOR_6_RELEASES,
        publishNtfy,
      })
    ).rejects.toThrow(/no filing configuration is wired/);
  });

  it('a filing API failure still pages, fails the run and leaves state unwritten', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const before = await readFile(statePath, 'utf8');
    const publishNtfy = vi.fn().mockResolvedValue(undefined);

    await expect(
      run({
        statePath,
        ntfy: { url: 'https://ntfy.example/topic' },
        fetchReleases: async () => MAJOR_6_RELEASES,
        publishNtfy,
        filingConfig: () => FILING_CONFIG,
        fileItem: async () => {
          throw new Error('GitHub POST /repos/branchLeft/workspace/issues failed: 403 Forbidden');
        },
      })
    ).rejects.toThrow(/403 Forbidden/);

    expect(publishNtfy).toHaveBeenCalledTimes(1);
    expect((publishNtfy.mock.calls[0] as [unknown, { message: string }])[1].message).toContain(
      'FILING FAILED'
    );
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
        ...filingAgainst(fakeWorkspace()),
      })
    ).rejects.toThrow(/ntfy publish failed/);

    expect(await readFile(statePath, 'utf8')).toBe(before);
  });

  it('a stalled ntfy publish fails the run and leaves state unwritten, so the next run retries', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const before = await readFile(statePath, 'utf8');
    const globalFetch = stallingFetch();
    vi.stubGlobal('fetch', globalFetch);
    try {
      await expect(
        run({
          statePath,
          ntfy: { url: 'https://ntfy.example/topic', timeoutMs: 25 },
          fetchReleases: async () => MAJOR_6_RELEASES,
          ...filingAgainst(fakeWorkspace()),
        })
      ).rejects.toThrow(new Error('ntfy publish timed out after 25 ms'));
      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch.mock.calls[0]![0]).toBe('https://ntfy.example/topic');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(await readFile(statePath, 'utf8')).toBe(before);
  });

  it('a stalled releases fetch fails the run before any page and leaves state unwritten', async () => {
    await writeFile(statePath, JSON.stringify({ lastNotifiedMajor: 5 }));
    const before = await readFile(statePath, 'utf8');
    const publishNtfy = vi.fn().mockResolvedValue(undefined);
    const globalFetch = stallingFetch();
    vi.stubGlobal('fetch', globalFetch);
    try {
      await expect(
        run({
          statePath,
          ntfy: { url: 'https://ntfy.example/topic' },
          fetchReleasesTimeoutMs: 25,
          publishNtfy,
        })
      ).rejects.toThrow(new Error('GitHub releases fetch timed out after 25 ms'));
      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch.mock.calls[0]![0]).toContain(
        'https://api.github.com/repos/TryGhost/Ghost/releases'
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(publishNtfy).not.toHaveBeenCalled();
    expect(await readFile(statePath, 'utf8')).toBe(before);
  });
});
