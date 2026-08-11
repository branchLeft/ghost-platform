import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Applied per-route (not globally) so it runs after Express has matched
 * `:domain`, letting it key by tenant rather than by IP — a shared Cloud
 * Run egress IP shouldn't let one noisy tenant throttle another's sends.
 * Falls back to IP only for requests that don't even parse to a domain
 * (malformed paths never reach a tenant-specific limit anyway).
 *
 * Limits are generous placeholders for a service with no production
 * traffic yet (doc 13 §4's volume band is low hundreds of recipients);
 * revisit once real send/poll volume exists to tune against.
 */
export function tenantRateLimiter(limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) =>
      (req.params.domain as string | undefined) ?? req.ip ?? 'unknown',
  });
}
