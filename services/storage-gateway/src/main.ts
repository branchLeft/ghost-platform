import { ConfigError, loadConfig } from './config.js';
import { MasterSecretError } from './credentials/masterSecret.js';
import { StoreRollbackError } from './credentials/store.js';
import { createLog } from './logging.js';
import { startGateway } from './start.js';
import { startStateGateway } from './start-state.js';

// The process entry: signals and exit codes only. Everything it calls is tested.
const log = createLog((line) => process.stdout.write(`${line}\n`));

/** These errors are written to be logged: they name what is wrong and never a value. */
function describe(error: unknown): string {
  if (error instanceof ConfigError || error instanceof MasterSecretError) return error.message;
  if (error instanceof StoreRollbackError) return error.message;
  return error instanceof Error ? error.name : 'NonError';
}

try {
  const config = loadConfig(process.env);
  const options = { env: process.env, sink: (line: string) => process.stdout.write(`${line}\n`) };
  // One binary, two services: STORAGE_GATEWAY_PROFILE picks which, and each runs as its own process with its own keys.
  const running =
    config.profile === 'state'
      ? await startStateGateway(config, options)
      : await startGateway(config, options);
  const shutdown = (signal: string): void => {
    log.service({ event: 'service', message: 'signal received', detail: signal });
    running.stop().then(
      ({ forced }) => process.exit(forced ? 1 : 0),
      () => process.exit(1)
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
} catch (error) {
  log.service({ event: 'service', message: 'refusing to start', detail: describe(error) });
  process.exit(1);
}
