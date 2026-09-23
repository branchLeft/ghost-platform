import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { DescriptorStore } from './descriptorStore.js';
import { TokenBucket } from './rateLimiter.js';

const config = loadConfig();
const store = new DescriptorStore({
  descriptorDir: config.descriptorDir,
  baseDomain: config.baseDomain,
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
