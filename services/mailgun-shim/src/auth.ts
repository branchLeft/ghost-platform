import type { NextFunction, Request, Response } from 'express';
import { hashApiKey } from './crypto.js';
import type { ShimStore, Tenant } from './store.js';

declare module 'express-serve-static-core' {
  interface Locals {
    tenant?: Tenant;
  }
}

function parseBasicAuth(header: string | undefined): { password: string } | null {
  if (!header || !header.startsWith('Basic ')) {
    return null;
  }
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return null;
  }
  // Ghost's mailgun.js client always authenticates with HTTP Basic auth,
  // username "api", password = the configured API key
  // (mailgun-client.js getInstance()) — the username itself carries no
  // tenant identity, so only the password half matters here.
  return { password: decoded.slice(separatorIndex + 1) };
}

/**
 * A key may only send or read as its own tenant's domain (doc 13 §2.6) — an
 * unknown key and a key/domain mismatch get the same 401 treatment as each
 * other, since Ghost's batch-sending-service.js doesn't branch on status
 * code: every send failure is logged, retried, and the batch marked failed
 * the same way regardless of which HTTP status caused it.
 */
export function requireTenantForDomain(store: ShimStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const credentials = parseBasicAuth(req.headers.authorization);
    if (!credentials) {
      res.status(401).json({ message: 'Missing or malformed Authorization header' });
      return;
    }

    const tenant = store.getTenantByApiKeyHash(hashApiKey(credentials.password));
    if (!tenant || tenant.domain !== req.params.domain) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    res.locals.tenant = tenant;
    next();
  };
}
