import { createMock } from './server.js';
import { MockConfigError, readConfig } from './config.js';

/** Serves the in-memory provisioning mock until the process is stopped. */
function main(): void {
  let config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    if (error instanceof MockConfigError) {
      process.stderr.write(`provisioning mock: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
  const { server } = createMock({
    credentials: config.credentials,
    tenants: config.tenants,
    onError: (error) => {
      process.stderr.write(
        `provisioning mock: ${error instanceof Error ? error.message : 'error'}\n`
      );
    },
  });
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    process.stdout.write(`provisioning mock listening on http://${config.host}:${String(port)}\n`);
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
