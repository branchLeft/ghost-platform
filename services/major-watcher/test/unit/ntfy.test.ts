import { describe, expect, it, vi } from 'vitest';
import { publish } from '../../src/ntfy.js';

function okResponse(): Response {
  return { ok: true, status: 200, statusText: 'OK' } as Response;
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
});
