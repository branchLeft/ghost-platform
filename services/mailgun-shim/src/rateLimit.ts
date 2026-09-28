import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Keys by tenant, falling back to the IP (IPv6 grouped by prefix) only
 * for a path with no domain. Limits are placeholders until real volume.
 * See rateLimit.md#tenantratelimiter.
 */
export function tenantRateLimiter(limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const domain = req.params.domain as string | undefined;
      if (domain) return domain;
      return req.ip ? ipKeyGenerator(req.ip) : 'unknown';
    },
  });
}
