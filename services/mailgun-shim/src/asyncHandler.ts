import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from './log.js';

/**
 * Express 4 does not catch a rejected promise returned by an async route
 * handler — a throw anywhere in one (sync or from an awaited call) becomes
 * an unhandled rejection, which crashes the process under Node's default
 * behaviour. On a single-instance service that takes down every tenant's
 * mail until the process is restarted, over one bad request. Every async
 * handler must go through this rather than being registered directly.
 */
export function asyncHandler(
  log: Logger,
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch((err: unknown) => {
      log.error('request_failed', {
        method: req.method,
        path: req.path,
        error: err instanceof Error ? err.message : String(err),
      });
      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(500).json({ message: 'Internal error' });
    });
  };
}
