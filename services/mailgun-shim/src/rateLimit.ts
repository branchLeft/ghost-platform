import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Keys by tenant, falling back to the IP (IPv6 grouped by prefix) only
 * for a path with no domain. Limits are placeholders until real volume.
 * See rateLimit.md#tenantratelimiter.
 *
 * Mount it after requireTenantForDomain on every route that has a :domain
 * segment. The key is that segment, and a caller chooses it. Before
 * authentication, a stranger could spend a tenant's budget with requests
 * that carry no valid key; after it, the segment is the authenticated tenant.
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
