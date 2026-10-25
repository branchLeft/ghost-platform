import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { publish } from '../../src/ntfy.js';

function okResponse(): Response {
  return { ok: true, status: 200, statusText: 'OK' } as Response;
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

describe('publish', () => {
  it('POSTs the message as the body with Title/Priority/Tags headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await publish(
      { url: 'https://ntfy.example.branchleft.co.uk/ghost-major-watcher' },
      {
        title: 'Ghost 7.0.0',
        message: 'announced',
        priority: 'high',
        tags: ['ghost', 'major-version'],
      },
      fetchImpl
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ntfy.example.branchleft.co.uk/ghost-major-watcher',
      expect.objectContaining({
        method: 'POST',
        body: 'announced',
        headers: expect.objectContaining({
          Title: 'Ghost 7.0.0',
          Priority: 'high',
          Tags: 'ghost,major-version',
        }),
      })
    );
  });

  it('adds a Bearer Authorization header only when a token is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await publish(
      { url: 'https://ntfy.example/topic', token: 'sek' },
      { title: 't', message: 'm' },
      fetchImpl
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, Parameters<typeof fetch>[1]];
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sek');
  });

  it('omits Authorization with no token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await publish({ url: 'https://ntfy.example/topic' }, { title: 't', message: 'm' }, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as [string, Parameters<typeof fetch>[1]];
    expect((init!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws when the publish is not ok', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' } as Response);
    await expect(
      publish({ url: 'https://ntfy.example/topic' }, { title: 't', message: 'm' }, fetchImpl)
    ).rejects.toThrow(/401/);
  });

  it('passes an AbortSignal that has not fired to fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await publish({ url: 'https://ntfy.example/topic' }, { title: 't', message: 'm' }, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as [string, Parameters<typeof fetch>[1]];
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(init!.signal!.aborted).toBe(false);
  });

  it('uses a 10000 ms limit by default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetchImpl = vi.fn().mockResolvedValue(okResponse());
      await publish({ url: 'https://ntfy.example/topic' }, { title: 't', message: 'm' }, fetchImpl);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).toHaveBeenCalledWith(10000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('throws a plain Error naming the limit when the request is aborted by the timeout', async () => {
    const token = 'SYNTHETIC_TOKEN_VALUE';
    const url = 'https://ntfy.example/secret-topic';
    const fetchImpl = stallingFetch();
    const rejected = await publish(
      { url, token, timeoutMs: 25 },
      { title: 't', message: 'm' },
      fetchImpl
    ).catch((error: unknown) => error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).name).toBe('Error');
    expect((rejected as Error).message).toBe('ntfy publish timed out after 25 ms');
    expect((rejected as Error).message).not.toContain(token);
    expect((rejected as Error).message).not.toContain(url);
    expect((rejected as Error).message).not.toContain('Bearer');
  });

  it('propagates a failure that is not the timeout unchanged', async () => {
    const failure = new Error('connection refused');
    const fetchImpl = vi.fn().mockRejectedValue(failure);
    const rejected = await publish(
      { url: 'https://ntfy.example/topic' },
      { title: 't', message: 'm' },
      fetchImpl
    ).catch((error: unknown) => error);
    expect(rejected).toBe(failure);
  });

  it('falls back to the default limit for an unusable timeoutMs', async () => {
    const unusable = [0, -1, NaN, Infinity, 1.5, 2147483648, 10000000000];
    for (const timeoutMs of unusable) {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      try {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse());
        await publish(
          { url: 'https://ntfy.example/topic', timeoutMs },
          { title: 't', message: 'm' },
          fetchImpl
        );
        expect(timeoutSpy).toHaveBeenCalledWith(10000);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const [, init] = fetchImpl.mock.calls[0] as [string, Parameters<typeof fetch>[1]];
        expect(init!.signal!.aborted).toBe(false);
      } finally {
        timeoutSpy.mockRestore();
      }
    }
  });
});
