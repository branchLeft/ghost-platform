import express, { type Express } from 'express';
import type { DescriptorTargetStore } from './descriptorTargets.js';

/**
 * Unauthenticated, like every other service here's /healthz: a gauge for
 * ops1's own process supervision, nothing a compromised container could
 * act on. Never the drain port of any host this collector reaches into --
 * that credential lives only in the outbound client, never answered here.
 */
export function createApp(store: DescriptorTargetStore): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      targetCount: store.targets.length,
      descriptorStale: store.isStale,
    });
  });

  return app;
}
