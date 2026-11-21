import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { readScrape } from '../collector/readScrape.js';
import { readText, requireEnv } from '../shell/config.js';
import { createPortalPool } from '../shell/pool.js';
import { recordKeyDestruction } from './record.js';

// One run for one erasure: the erase command's output arrives on standard
// input, from the control host's run of it (this container has no route to a
// host), and the run's lines go to standard error. It holds no credential the
// console does not already hold: the console's own database URL file. Exit 0
// only when the proof was read, named a tenant with a waiting request, and the
// write was made; 1 otherwise.
const writeLine = (line: string): void => void process.stderr.write(`${line}\n`);

async function run(): Promise<number> {
  const databaseUrl = readText(requireEnv(process.env, 'CONSOLE_DATABASE_URL_FILE')).trim();
  const text = await readScrape(process.stdin);
  if (text === null) {
    writeLine('erasure: the text is too long; nothing written');
    return 1;
  }
  const pool = createPortalPool({ connectionString: databaseUrl, onError: writeLine });
  try {
    const outcome = await recordKeyDestruction(new OwnerDb(pool), text, writeLine);
    return outcome.recorded ? 0 : 1;
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
    writeLine(`erasure: run failed: ${error instanceof Error ? error.name : typeof error}`);
    process.exitCode = 1;
  }
);
