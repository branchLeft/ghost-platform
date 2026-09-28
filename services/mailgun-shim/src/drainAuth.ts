import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const BEARER_PREFIX = 'Bearer ';

function parseBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return header.slice(BEARER_PREFIX.length);
}

/**
 * Fixed-length digest comparison rather than comparing the raw tokens: the
 * drain endpoint hands out queued mail, so a timing side-channel on the
 * token itself (distinguishable by response latency across many requests)
 * is exactly the class of leak that matters here. Hashing first also means
 * timingSafeEqual never sees two buffers of different length — it throws
 * on a length mismatch, which a naive `Buffer.from(a).length ===
 * Buffer.from(b).length` guard would itself leak one bit of information
 * about the true token's length.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * The drain endpoint's only credential: one shared bearer token, because
 * the drainer is the one caller this host expects, not a tenant.
 * See drainAuth.md#requiredraintoken.
 */
export function requireDrainToken(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = parseBearerToken(req.headers.authorization);
    if (!presented || !constantTimeEquals(presented, expectedToken)) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    next();
  };
}
