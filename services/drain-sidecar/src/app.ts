import express, { type Express } from 'express';
import type { DrainFlag } from './drainFlag.js';
import type { GhostProbe } from './ghostProbe.js';
import { renderMetrics } from './metrics.js';
import { deriveVersionState } from './versionState.js';
import type { GhostVersionProbe } from './versionProbe.js';

/**
 * The one route this service exists to serve. A slot's health is the drain
 * flag, not Ghost, so the flag is checked first and short-circuits to 503
 * without ever asking Ghost -- a sidecar that asked Ghost first and used the
 * flag as a tie-breaker would still leak Ghost's opinion into the drained
 * case on a slow or flaky probe. 200 only when the flag is clear AND
 * Ghost's own probe answers 200.
 *
 * `/metrics` is scraped, not held, so it carries the drain flag's own
 * state plus Ghost's reported version and, only for the undrained colour,
 * whether that matches what `intendedVersion` says the descriptor wants.
 * See `versionState.ts` for why that gating lives there and nowhere else.
 */
export function createApp(
  drainFlag: DrainFlag,
  ghost: GhostProbe,
  ghostVersion: GhostVersionProbe,
  intendedVersion: string | null
): Express {
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

  app.get('/metrics', async (_req, res) => {
    const drained = drainFlag.isSet();
    // Asking Ghost for its version even while drained would cost nothing
    // functionally -- `deriveVersionState` discards it regardless -- but
    // it is still an unnecessary call to a colour nothing should be
    // reading from, so it is skipped rather than made and thrown away.
    const rawReported = drained ? null : await ghostVersion.getVersion();
    const versionState = deriveVersionState({ intended: intendedVersion, rawReported, drained });
    res.status(200).type('text/plain; version=0.0.4').send(renderMetrics(drained, versionState));
  });

  return app;
}
