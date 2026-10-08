# serverStartupOutcomesOptIn.test.ts

Starts the real compiled `dist/server.js` as its own process, with a clean
environment, and calls `POST /drain/outcomes`. Router tests build the router with
the flag already decided and `loadConfig` tests read the flag, so neither can
notice an entrypoint that ignores the configuration. Unset, `false`, `1` and
`TRUE` must all leave the route absent (404 even with the right token); only the
exact string `true` serves it.
