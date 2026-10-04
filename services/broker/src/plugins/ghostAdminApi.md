# ghostAdminApi.ts

## ghostAdminApi

The real `AdminApiClient` the env template names. It reads
`BROKER_ADMIN_KEY_DIR`, `BROKER_GHOST_READY_TIMEOUT_MS` and the zone
variables when it is loaded (`config.ts#adminApiConfigFromEnv`), so a
missing key folder stops the broker at start rather than at the first
build. It exports `real: true`, so `/status` does not list it.
