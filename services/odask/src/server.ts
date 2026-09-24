import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { DescriptorStore } from './descriptorStore.js';
import { isEveryInterfaceAddress } from './hostname.js';
import { TokenBucket } from './rateLimiter.js';

const config = loadConfig();
const store = new DescriptorStore({
  descriptorDir: config.descriptorDir,
  platformZone: config.platformZone,
  ownedDomains: config.ownedDomains,
  maxStalenessMs: config.descriptorMaxStalenessMs,
});
const rateLimiter = new TokenBucket(config.rateLimitCapacity, config.rateLimitRefillPerSecond);

await store.refresh();
const refreshTimer = setInterval(() => {
  store.refresh().catch((error: unknown) => {
    console.error('odask: descriptor refresh failed', error);
  });
}, config.refreshIntervalMs);
refreshTimer.unref();

const app = createApp(store, rateLimiter);

// Bound explicitly to config.bindHost -- never left to default to every
// interface. See AskConfig.bindHost and LLD-5 E2: Caddy sends no credential,
// so this service's only defence is its network position.
const server = app.listen(config.port, config.bindHost, () => {
  // The real guard: what the kernel actually bound, not the string that
  // was asked for. config.ts's own BIND_HOST check is a denylist over a
  // few spellings and cannot be complete; this checks the one fact that
  // is -- see hostname.ts's isEveryInterfaceAddress.
  const bound = server.address();
  const boundAddress = typeof bound === 'object' && bound !== null ? bound.address : undefined;
  if (boundAddress !== undefined && isEveryInterfaceAddress(boundAddress)) {
    console.error(
      `odask: refusing to run -- BIND_HOST "${config.bindHost}" resolved to every interface ` +
        `(${boundAddress}), which defeats this service's only defence (LLD-5 E2)`
    );
    server.close(() => process.exit(1));
    return;
  }
  console.log(
    `odask listening on ${config.bindHost}:${config.port}, descriptors=${config.descriptorDir}`
  );
});

function shutdown(): void {
  clearInterval(refreshTimer);
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
