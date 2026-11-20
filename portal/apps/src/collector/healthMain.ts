import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { createPortalPool } from '../shell/pool.js';
import { readText, requireEnv } from '../shell/config.js';
import { collectHealth } from './healthCollect.js';
import { readScrape } from './readScrape.js';

// One run of the health collector: the native program on ops1 that read each
// tenant's drain sidecars (the container has no route to a host) sends its
// report on standard input, and the run's lines go to standard error. It holds
// no credential the console does not already hold: the console's own database
// URL file, which the container is given. Exit 0 when the report was read and
// every write was made; 1 otherwise.
const writeLine = (line: string): void => void process.stderr.write(`${line}\n`);

async function run(): Promise<number> {
  const databaseUrl = readText(requireEnv(process.env, 'CONSOLE_DATABASE_URL_FILE')).trim();
  const report = await readScrape(process.stdin);
  if (report === null) {
    writeLine('health: the report is too long; nothing written');
    return 1;
  }
  const pool = createPortalPool({ connectionString: databaseUrl, onError: writeLine });
  try {
    const summary = await collectHealth({
      sink: new OwnerDb(pool),
      report,
      now: new Date(),
      log: writeLine,
    });
    return summary.accepted && summary.failed === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

run().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // The error's name alone: its message can carry connection details.
    writeLine(`health: run failed: ${error instanceof Error ? error.name : typeof error}`);
    process.exitCode = 1;
  }
);
