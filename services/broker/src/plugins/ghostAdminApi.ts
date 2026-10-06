/**
 * The `AdminApiClient` seam (`../adminApi.ts`), filled with the real
 * client (`../ghostAdmin/client.ts`). Reads its configuration when loaded,
 * so a missing `BROKER_ADMIN_KEY_DIR` stops the broker starting at all.
 * See ghostAdminApi.md#ghostadminapi.
 */
import type { AdminApiClient } from '../adminApi.js';
import { adminApiConfigFromEnv } from '../config.js';
import { createGhostAdminClient } from '../ghostAdmin/client.js';
import { createAdminKeyStore } from '../ghostAdmin/keyStore.js';
import type { SeamMarker } from '../seamReadiness.js';

const config = adminApiConfigFromEnv(process.env);

const adminApi: AdminApiClient & SeamMarker = {
  real: true,
  ...createGhostAdminClient({
    keyStore: createAdminKeyStore(config.keyDir),
    zones: config.zones,
    readyTimeoutMs: config.readyTimeoutMs,
  }),
};

export default adminApi;
