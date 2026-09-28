import express, { type Express } from 'express';
import { createLogger, type Logger } from './log.js';
import type { DrainRouterOptions } from './routes/drain.js';
import { createDrainRouter } from './routes/drain.js';
import { createEventsRouter } from './routes/events.js';
import { createMessagesRouter } from './routes/messages.js';
import { createSuppressionsRouter } from './routes/suppressions.js';
import { renderMetrics } from './metrics.js';
import type { DrainWake } from './drainWake.js';
import type { ShimStore } from './store.js';
import type { Throttle } from './throttle.js';

/**
 * Assembles the Mailgun-shaped routes, the drain handover, health and metrics.
 * No global body parser: the messages route reads the multipart stream itself.
 * See app.md#createapp.
 */
export function createApp(
  store: ShimStore,
  wake: DrainWake,
  drainToken: string,
  drainOptions: DrainRouterOptions,
  throttle: Throttle,
  log: Logger = createLogger()
): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    try {
      store.ping();
      res.status(200).json({
        status: 'ok',
        undrained: store.countUndrainedRecipients(),
      });
    } catch {
      res.status(500).json({ status: 'error' });
    }
  });

  // Unauthenticated, like /healthz: it is a gauge and a counter, nothing a
  // prospect or a compromised container could act on, and Prometheus scrape
  // configs don't carry this service's drain credential.
  app.get('/metrics', (_req, res) => {
    res.status(200).type('text/plain; version=0.0.4').send(renderMetrics(store));
  });

  app.use(createMessagesRouter(store, wake, log));
  app.use(createEventsRouter(store));
  app.use(createSuppressionsRouter(store));
  app.use(createDrainRouter(store, wake, drainToken, drainOptions, log, throttle));

  return app;
}
