import express, { type Express } from 'express';
import { createEventsRouter } from './routes/events.js';
import { createMessagesRouter } from './routes/messages.js';
import { createSuppressionsRouter } from './routes/suppressions.js';
import type { Transporter } from './smtp.js';
import type { ShimStore } from './store.js';

/**
 * Assembles the three Mailgun-shaped endpoints Ghost's bulk-email path
 * calls (doc 13 §1.3/§2.4). Deliberately no global body-parser: the
 * messages route reads the multipart body itself via busboy, and adding
 * express.json()/urlencoded() ahead of it would consume the request stream
 * before busboy sees it.
 *
 * Ghost joins `bulkEmail__mailgun__baseUrl` on its `.origin` only (doc 13
 * §1.3's `baseUrl.origin` note — the mailgun.js client is constructed with
 * `url: baseUrl.origin`, discarding any path), so every route below is
 * mounted at the app root rather than under a configurable prefix.
 */
export function createApp(store: ShimStore, transport: Transporter): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(createMessagesRouter(store, transport));
  app.use(createEventsRouter(store));
  app.use(createSuppressionsRouter(store));

  return app;
}
