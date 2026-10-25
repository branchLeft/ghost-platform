import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { fetchGhostReleases } from '../../src/ghostReleases.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

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

  it('passes an AbortSignal that has not fired to fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    await fetchGhostReleases({ fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, Parameters<typeof fetch>[1]];
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(init!.signal!.aborted).toBe(false);
  });

  it('uses a 30000 ms limit by default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
      await fetchGhostReleases({ fetchImpl });
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).toHaveBeenCalledWith(30000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('throws a plain Error naming the limit when the request stalls', async () => {
    const token = 'SYNTHETIC_TOKEN_VALUE';
    const fetchImpl = stallingFetch();
    const rejected = await fetchGhostReleases({ fetchImpl, token, timeoutMs: 25 }).catch(
      (error: unknown) => error
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).name).toBe('Error');
    expect((rejected as Error).message).toBe('GitHub releases fetch timed out after 25 ms');
    expect((rejected as Error).message).not.toContain(token);
    expect((rejected as Error).message).not.toContain('Bearer');
  });

  it('throws a plain Error naming the limit when the body read stalls', async () => {
    const token = 'SYNTHETIC_TOKEN_VALUE';
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      const signal = init?.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      } as unknown as Response);
    });
    const rejected = await fetchGhostReleases({ fetchImpl, token, timeoutMs: 25 }).catch(
      (error: unknown) => error
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).name).toBe('Error');
    expect((rejected as Error).message).toBe('GitHub releases fetch timed out after 25 ms');
    expect((rejected as Error).message).not.toContain(token);
    expect((rejected as Error).message).not.toContain('Bearer');
  });

  it('propagates a failure that is not the timeout unchanged', async () => {
    const failure = new Error('connection refused');
    const fetchImpl = vi.fn().mockRejectedValue(failure);
    const rejected = await fetchGhostReleases({ fetchImpl }).catch((error: unknown) => error);
    expect(rejected).toBe(failure);
  });

  it('falls back to the default limit for an unusable timeoutMs', async () => {
    const unusable = [0, -1, NaN, Infinity, 1.5, 2147483648, 10000000000];
    for (const timeoutMs of unusable) {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      try {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
        await fetchGhostReleases({ fetchImpl, timeoutMs });
        expect(timeoutSpy).toHaveBeenCalledWith(30000);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const [, init] = fetchImpl.mock.calls[0] as [string, Parameters<typeof fetch>[1]];
        expect(init!.signal!.aborted).toBe(false);
      } finally {
        timeoutSpy.mockRestore();
      }
    }
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
