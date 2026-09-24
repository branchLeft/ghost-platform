import { describe, expect, it, vi } from 'vitest';
import { fetchGhostReleases } from '../../src/ghostReleases.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

describe('fetchGhostReleases', () => {
  it('maps the GitHub API shape to GhostRelease', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          tag_name: 'v6.55.0',
          published_at: '2026-07-31T16:17:29Z',
          draft: false,
          prerelease: false,
        },
        {
          tag_name: 'v6.0.0-rc.2',
          published_at: '2025-07-31T19:22:39Z',
          draft: false,
          prerelease: false,
        },
      ])
    );

    const releases = await fetchGhostReleases({ fetchImpl });

    expect(releases).toEqual([
      { tagName: 'v6.55.0', publishedAt: '2026-07-31T16:17:29Z', draft: false },
      { tagName: 'v6.0.0-rc.2', publishedAt: '2025-07-31T19:22:39Z', draft: false },
    ]);
  });

  it('sends an Authorization header when a token is given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    await fetchGhostReleases({ fetchImpl, token: 'tok123' });
    const [, init] = fetchImpl.mock.calls[0] as [string, Parameters<typeof fetch>[1]];
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok123');
  });

  it('omits Authorization when no token is given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    await fetchGhostReleases({ fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, Parameters<typeof fetch>[1]];
    expect((init!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    await expect(fetchGhostReleases({ fetchImpl })).rejects.toThrow(/503/);
  });

  it('throws on a non-array response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'not found' }));
    await expect(fetchGhostReleases({ fetchImpl })).rejects.toThrow(/not an array/);
  });

  it('throws on a release entry missing required fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ draft: false }]));
    await expect(fetchGhostReleases({ fetchImpl })).rejects.toThrow(/missing tag_name/);
  });

  it('falls back to the global fetch when no fetchImpl is injected', async () => {
    const globalFetch = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', globalFetch);
    try {
      await fetchGhostReleases();
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
