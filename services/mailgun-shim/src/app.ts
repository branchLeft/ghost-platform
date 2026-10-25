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

function newApp(store: ShimStore): Express {
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

  return app;
}

function mountMailRoutes(app: Express, store: ShimStore, wake: DrainWake, log: Logger): void {
  app.use(createMessagesRouter(store, wake, log));
  app.use(createEventsRouter(store));
  app.use(createSuppressionsRouter(store));
}

function mountDrainRoutes(
  app: Express,
  store: ShimStore,
  wake: DrainWake,
  drainToken: string,
  drainOptions: DrainRouterOptions,
  throttle: Throttle,
  log: Logger
): void {
  app.use(createDrainRouter(store, wake, drainToken, drainOptions, log, throttle));
}

/**
 * The tenant-facing listener: the Mailgun-shaped routes, health and
 * metrics, and no drain route at all, so /drain is a 404 here whatever
 * token a caller holds. See app.md#createmailapp.
 */
export function createMailApp(
  store: ShimStore,
  wake: DrainWake,
  log: Logger = createLogger()
): Express {
  const app = newApp(store);
  mountMailRoutes(app, store, wake, log);
  return app;
}

/**
 * The drain listener: the drain handover, health and metrics, and no
 * Mailgun-shaped route. See app.md#createdrainapp.
 */
export function createDrainApp(
  store: ShimStore,
  wake: DrainWake,
  drainToken: string,
  drainOptions: DrainRouterOptions,
  throttle: Throttle,
  log: Logger = createLogger()
): Express {
  const app = newApp(store);
  mountDrainRoutes(app, store, wake, drainToken, drainOptions, throttle, log);
  return app;
}

/**
 * Assembles the Mailgun-shaped routes, the drain handover, health and metrics
 * on one app. Used when no separate drain port is configured; a spool host
 * runs createMailApp and createDrainApp on their own listeners instead.
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
  const app = newApp(store);
  mountMailRoutes(app, store, wake, log);
  mountDrainRoutes(app, store, wake, drainToken, drainOptions, throttle, log);
  return app;
}
