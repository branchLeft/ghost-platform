# serverStartupSplitListener.test.ts

Starts the real compiled `dist/server.js` as its own process, with a clean
environment. With `SHIM_DRAIN_PORT` set, `GET /drain` and `POST /drain/ack`
answer on that port with the drain token, and the mail API port answers 404 to
both even with the token; the Mailgun-shaped API and `/healthz` stay on the
mail API port. With `SHIM_DRAIN_PORT` equal to `PORT` the process exits non-zero
before listening. Unit tests of the two apps and of `loadConfig` cannot see an
entrypoint that mounts the drain handover on the mail listener anyway.
