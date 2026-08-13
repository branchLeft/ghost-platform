import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSqliteStore, type ShimStore } from './store.js';

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export function generateApiKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Opens the DB directly (WAL makes this safe alongside the running
 * service). Never routes through src/log.ts — a plaintext API key must
 * reach the operator's terminal exactly once and never through anything
 * that could end up in a log line or log aggregator.
 */
export async function runCli(
  argv: string[],
  openStore: () => ShimStore,
  io: CliIO
): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'register': {
      const domain = rest[0];
      if (!domain) {
        io.stderr('Usage: register <domain> [--rotate]');
        return 1;
      }
      const rotate = rest.includes('--rotate');
      const store = openStore();
      try {
        // registerTenant is INSERT OR REPLACE — without this guard a
        // second `register` for a live domain would silently rotate its
        // key out from under it.
        if (store.tenantExists(domain) && !rotate) {
          io.stderr(`Tenant ${domain} already exists. Pass --rotate to replace its key.`);
          return 1;
        }
        const apiKey = generateApiKey();
        store.registerTenant(domain, apiKey);
        io.stdout(`Registered ${domain}.`);
        io.stdout('API key (shown once — it will not be shown again):');
        io.stdout(apiKey);
        return 0;
      } finally {
        store.close();
      }
    }

    case 'list': {
      const store = openStore();
      try {
        for (const domain of store.listTenants()) {
          io.stdout(domain);
        }
        return 0;
      } finally {
        store.close();
      }
    }

    case 'events': {
      const domain = rest[0];
      if (!domain) {
        io.stderr('Usage: events <domain> [--limit N]');
        return 1;
      }
      const limitIndex = rest.indexOf('--limit');
      const limitArg = limitIndex !== -1 ? Number(rest[limitIndex + 1]) : NaN;
      const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 300;
      const store = openStore();
      try {
        const { events } = store.listEvents(domain, { limit, offset: 0 });
        for (const event of events) {
          io.stdout(JSON.stringify(event));
        }
        return 0;
      } finally {
        store.close();
      }
    }

    default:
      io.stderr(`Unknown command: ${command ?? '(none)'}`);
      io.stderr('Usage: cli.js <register|list|events> ...');
      return 1;
  }
}

/* v8 ignore start -- process entrypoint wiring (argv/env/exit), same shape as server.ts; runCli above carries the tested behaviour. */
function main(): void {
  const dbPath = process.env.SHIM_DB_PATH;
  if (!dbPath) {
    process.stderr.write('SHIM_DB_PATH is required.\n');
    process.exit(1);
  }
  const io: CliIO = {
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
  };
  void runCli(process.argv.slice(2), () => createSqliteStore(dbPath), io).then((code) => {
    process.exitCode = code;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
/* v8 ignore stop */
