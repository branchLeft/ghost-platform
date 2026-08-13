import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { asyncHandler } from '../../src/asyncHandler.js';
import { createTestLogger } from '../helpers/testLogger.js';

function fakeRes(headersSent: boolean): Response {
  return {
    headersSent,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('asyncHandler', () => {
  it('awaits a resolving handler and does nothing extra', async () => {
    const { logger } = createTestLogger();
    const inner = vi.fn(async () => {
      // resolves cleanly
    });
    const wrapped = asyncHandler(logger, inner);
    const res = fakeRes(false);
    const next = vi.fn() as NextFunction;

    wrapped({ method: 'GET', path: '/x' } as Request, res, next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inner).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('turns a rejection into a 500 JSON response and a structured log line when headers were not yet sent', async () => {
    const { logger, lines } = createTestLogger();
    const wrapped = asyncHandler(logger, async () => {
      throw new Error('boom');
    });
    const res = fakeRes(false);
    const next = vi.fn() as NextFunction;

    wrapped({ method: 'POST', path: '/v3/x/messages' } as Request, res, next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Internal error' });
    expect(next).not.toHaveBeenCalled();
    expect(
      lines.some(
        (line) =>
          line.event === 'request_failed' &&
          line.fields.error === 'boom' &&
          line.fields.path === '/v3/x/messages'
      )
    ).toBe(true);
  });

  it('defers to next(err) instead of writing a response when headers were already sent', async () => {
    const { logger } = createTestLogger();
    const wrapped = asyncHandler(logger, async () => {
      throw new Error('boom after headers sent');
    });
    const res = fakeRes(true);
    const next = vi.fn() as NextFunction;

    wrapped({ method: 'POST', path: '/v3/x/messages' } as Request, res, next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('stringifies a non-Error rejection rather than crashing the logger', async () => {
    const { logger, lines } = createTestLogger();
    const wrapped = asyncHandler(logger, async () => {
      // Deliberately not an Error — exercises the non-Error rejection branch.
      throw 'a plain string rejection';
    });
    const res = fakeRes(false);
    const next = vi.fn() as NextFunction;

    wrapped({ method: 'GET', path: '/x' } as Request, res, next);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(lines.some((line) => line.fields.error === 'a plain string rejection')).toBe(true);
  });
});
