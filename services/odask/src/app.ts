import express, { type Express } from 'express';
import type { DescriptorStore } from './descriptorStore.js';
import { isSyntacticallyValidHostname, normalizeHostname } from './hostname.js';
import type { TokenBucket } from './rateLimiter.js';

/**
 * The one route Caddy's `on_demand_tls { ask ... }` calls, once per new SNI,
 * before it orders anything: `GET /?domain=<sni>`. 200 admits the name; any
 * other status refuses it and the handshake fails with no HTTP status at
 * all on Caddy's side (LLD-5 E1) -- so every refusal path here can pick
 * whichever non-2xx status is clearest for our own logs without changing
 * what Caddy does with it.
 *
 * Fails closed by construction: every branch below that is not the single
 * "hostname is in the served set" branch ends in a non-200 response, and
 * there is no branch that falls through without setting a status.
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
