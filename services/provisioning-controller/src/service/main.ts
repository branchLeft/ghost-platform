import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceConfigError, readServiceConfig } from './config.js';
import { createService } from './service.js';
import { StateFileError } from './stateFile.js';

/** Serves the provisioning API until the process is stopped. */
function main(): void {
  const write = (text: string): void => {
    process.stderr.write(`provisioning service: ${text}\n`);
  };
  let service;
  let config;
  try {
    config = readServiceConfig(process.env);
    service = createService({
      config: { ...config, stateDir: mkdtempSync(join(tmpdir(), 'sabotage-')) },
      onProblem: (code) => write(code),
      onError: (error) => write(error instanceof Error ? error.name : 'error'),
    });
  } catch (error) {
    if (error instanceof ServiceConfigError || error instanceof StateFileError) {
      write(error.message);
      process.exit(2);
    }
    throw error;
  }
  const { server } = service;
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    process.stdout.write(`provisioning service listening on ${config.host}:${String(port)}\n`);
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
