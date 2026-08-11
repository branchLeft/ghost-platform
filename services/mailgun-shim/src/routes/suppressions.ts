import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { requireTenantForDomain } from '../auth.js';
import { tenantRateLimiter } from '../rateLimit.js';
import { SUPPRESSION_TYPES, type ShimStore, type SuppressionType } from '../store.js';

function isSuppressionType(value: string): value is SuppressionType {
  return (SUPPRESSION_TYPES as readonly string[]).includes(value);
}

/**
 * The real endpoint has no literal "suppressions" path segment — verified
 * by instrumenting mailgun.js's Suppressions#destroy, which the Ghost
 * client calls as `instance.suppressions.destroy(domain, type, email)`
 * (mailgun-client.js:280): it builds
 * `DELETE /v3/{domain}/{bounces|complaints|unsubscribes}/{email}` directly,
 * with `type` as the literal second path segment. Doc 13's own §1.3 table
 * has this right; a later summary of it drifted to
 * "/v3/{domain}/suppressions/{email}", which this route does not implement
 * because Ghost's real client never sends that URL.
 */
export function createSuppressionsRouter(store: ShimStore): Router {
  const router = createRouter();

  router.delete(
    '/v3/:domain/:type/:email',
    (req: Request, res: Response, next) => {
      if (!isSuppressionType(req.params.type as string)) {
        next('route');
        return;
      }
      next();
    },
    tenantRateLimiter(60),
    requireTenantForDomain(store),
    (req: Request, res: Response) => {
      const domain = req.params.domain as string;
      const type = req.params.type as SuppressionType;
      // Express already decodes path params, and mailgun.js encoded the
      // email with encodeURIComponent when building the request URL — no
      // second decode needed here.
      const email = req.params.email as string;

      store.removeSuppression(domain, type, email);
      res.status(200).json({ message: 'Suppression removed', address: email });
    }
  );

  return router;
}
