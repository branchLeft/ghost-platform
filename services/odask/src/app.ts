import express, { type Express } from 'express';
import type { DescriptorStore } from './descriptorStore.js';
import { isSyntacticallyValidHostname, normalizeHostname } from './hostname.js';
import type { TokenBucket } from './rateLimiter.js';

/**
 * Caddy's `on_demand_tls { ask ... }` route, called once per new SNI:
 * `GET /?domain=<sni>`. Fails closed by construction -- every branch not
 * the single "hostname is served" branch ends in a non-200 response.
 * See ../README.md#app-createapp.
 */
export function createApp(store: DescriptorStore, rateLimiter: TokenBucket): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/', (req, res) => {
    const domain = req.query.domain;

    if (typeof domain !== 'string' || domain.length === 0) {
      res.status(400).json({ error: 'missing or malformed domain parameter' });
      return;
    }
    if (!isSyntacticallyValidHostname(domain)) {
      res.status(400).json({ error: 'malformed domain parameter' });
      return;
    }

    const hostname = normalizeHostname(domain);
    if (store.has(hostname)) {
      res.status(200).json({ domain: hostname });
      return;
    }

    // Only a miss touches the ceiling -- an admitted hostname is a bounded
    // Set lookup regardless of rate (LLD-5 E3).
    if (!rateLimiter.tryConsume()) {
      res.status(429).json({ error: 'too many unknown-hostname requests' });
      return;
    }
    res.status(403).json({ error: 'hostname not served' });
  });

  return app;
}
