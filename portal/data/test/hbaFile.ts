import { testPool } from './helpers.js';

// Rewrites the test server's pg_hba.conf through the server itself (COPY ...
// TO, as the superuser), so the same tests run against a local cluster and
// the CI container. The file must be writable by the server's own user.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function query(text: string): Promise<Record<string, unknown>[]> {
  const pool = testPool('postgres', undefined, undefined, 1);
  try {
    return (await pool.query(text)).rows as Record<string, unknown>[];
  } finally {
    await pool.end();
  }
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function hbaPath(): Promise<string> {
  return String((await query("SELECT current_setting('hba_file') AS f"))[0]!['f']);
}

export async function readHba(): Promise<string> {
  const path = await hbaPath();
  return String((await query(`SELECT pg_read_file(${literal(path)}) AS t`))[0]!['t']);
}

/** Replaces the file's content; the server does not reload it. */
export async function writeHba(text: string): Promise<void> {
  const path = await hbaPath();
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.some((line) => /[\t\\]/.test(line)))
    throw new Error('tabs and backslashes are not written');
  const array = `ARRAY[${lines.map(literal).join(', ')}]::text[]`;
  await query(`COPY (SELECT unnest(${array})) TO ${literal(path)}`);
}

/**
 * Reloads the configuration once the clock has moved past the file's last
 * write, so the file is older than the load by at least a second, and waits
 * until the server reports the new load time.
 */
export async function reloadHba(): Promise<void> {
  await sleep(1100);
  const before = String((await query('SELECT pg_conf_load_time()::text AS t'))[0]!['t']);
  await query('SELECT pg_reload_conf()');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(100);
    const now = String((await query('SELECT pg_conf_load_time()::text AS t'))[0]!['t']);
    if (now !== before) return;
  }
  throw new Error('the server did not reload its configuration');
}

/** Runs `work` with the file changed, then restores the original and reloads. */
export async function withHba<T>(
  change: (original: string) => string,
  reload: boolean,
  work: () => Promise<T>
): Promise<T> {
  const original = await readHba();
  try {
    await writeHba(change(original));
    if (reload) await reloadHba();
    return await work();
  } finally {
    await writeHba(original);
    await reloadHba();
  }
}
