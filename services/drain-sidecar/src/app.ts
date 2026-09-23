import express, { type Express } from 'express';
import type { DrainFlag } from './drainFlag.js';
import type { GhostProbe } from './ghostProbe.js';

/**
 * The one route this service exists to serve. A slot's health is the drain
 * flag, not Ghost, so the flag is checked first and short-circuits to 503
 * without ever asking Ghost -- a sidecar that asked Ghost first and used the
 * flag as a tie-breaker would still leak Ghost's opinion into the drained
 * case on a slow or flaky probe. 200 only when the flag is clear AND
 * Ghost's own probe answers 200.
 */
export function createApp(drainFlag: DrainFlag, ghost: GhostProbe): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', async (_req, res) => {
    if (drainFlag.isSet()) {
      res.status(503).json({ status: 'drained' });
      return;
    }

    const healthy = await ghost.isHealthy();
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'ghost_unhealthy' });
  });

  return app;
}
