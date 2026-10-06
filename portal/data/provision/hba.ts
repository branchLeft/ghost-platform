import type { ClientBase } from 'pg';

// The cross-database control (M28, the design check's A2). PUBLIC keeps
// CONNECT on the server's other databases, so pg_hba is what keeps a portal
// login out of them. `pg_hba_file_rules` parses the file as it is now, not
// the rules the server has loaded, so the check also refuses a file changed
// since the last load or one that failed to load, and then observes the
// loaded rules directly by trying to log in.

export interface HbaRule {
  line: number;
  file: string;
  type: string | null;
  databases: readonly string[];
  users: readonly string[];
  method: string | null;
  error: string | null;
}

export interface HbaTarget {
  database: string;
  /** Each portal login with every role it reaches, or will reach, by name. */
  logins: readonly { name: string; reaches: readonly string[] }[];
}

/** Could this user entry match the login? Conservative: unknown forms match. */
function userCouldMatch(entry: string, login: { name: string; reaches: readonly string[] }) {
  if (entry === 'all' || entry === login.name) return true;
  if (entry.startsWith('+')) {
    const role = entry.slice(1);
    return role === login.name || login.reaches.includes(role);
  }
  // A regex (PostgreSQL 16+) or an included file could name anyone.
  return entry.startsWith('/') || entry.startsWith('@');
}

/** Could this database entry match a database other than the portal's? */
function databaseCouldBeOther(entry: string, database: string): boolean {
  return entry !== database;
}

/**
 * The static rule, ignoring order, type and address: no rule that accepts
 * may pair a portal login with any database other than the portal's.
 */
export function judgeHbaRules(rules: readonly HbaRule[], target: HbaTarget): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    const where = `${rule.file}:${rule.line}`;
    if (rule.error !== null) {
      problems.push(`pg_hba rule at ${where} does not parse: ${rule.error}`);
      continue;
    }
    if (rule.method === 'reject') continue;
    for (const login of target.logins) {
      const user = rule.users.find((entry) => userCouldMatch(entry, login));
      if (user === undefined) continue;
      const other = rule.databases.find((entry) => databaseCouldBeOther(entry, target.database));
      if (other !== undefined) {
        problems.push(
          `pg_hba rule at ${where} lets ${login.name} (as ${user}) reach database ${other} by ${rule.method ?? 'unknown'}`
        );
      }
    }
  }
  return problems;
}

/** Reads the rules and the state of every file they came from. */
export async function hbaProblems(client: ClientBase, target: HbaTarget): Promise<string[]> {
  const version = Number(
    (await client.query("SELECT current_setting('server_version_num')::int AS v")).rows[0].v
  );
  const hasFile = version >= 160000;
  const rows = await client.query(
    `SELECT line_number AS line, ${hasFile ? 'file_name' : "current_setting('hba_file')"} AS file,
            type, database, user_name AS users, auth_method AS method, error
       FROM pg_hba_file_rules ORDER BY 2, 1`
  );
  const rules: HbaRule[] = (rows.rows as Record<string, unknown>[]).map((row) => ({
    line: Number(row['line']),
    file: String(row['file']),
    type: (row['type'] as string | null) ?? null,
    databases: (row['database'] as string[] | null) ?? [],
    users: (row['users'] as string[] | null) ?? [],
    method: (row['method'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
  }));
  const problems = judgeHbaRules(rules, target);
  const files = new Set<string>([
    String((await client.query("SELECT current_setting('hba_file') AS f")).rows[0].f),
  ]);
  for (const rule of rules) if (rule.file !== 'null') files.add(rule.file);
  for (const file of [...files].sort()) {
    const changed = await client.query(
      `SELECT (pg_stat_file($1)).modification >= date_trunc('second', pg_conf_load_time())
                AS changed`,
      [file]
    );
    if ((changed.rows[0] as { changed: boolean }).changed) {
      problems.push(`pg_hba file ${file} changed at or after the last configuration load`);
    }
  }
  const pending = await client.query(
    "SELECT pending_restart FROM pg_settings WHERE name = 'hba_file'"
  );
  if ((pending.rows[0] as { pending_restart: boolean }).pending_restart) {
    problems.push('hba_file has a change pending a restart');
  }
  return problems;
}

/**
 * The behavioural probe: logs in as each portal login to each other database
 * and requires the server's pg_hba refusal (SQLSTATE 28000) every time. It is
 * the one check that observes the loaded rules.
 */
export async function probeOtherDatabases(
  databases: readonly string[],
  logins: readonly { name: string; password: string }[],
  attempt: (database: string, login: string, password: string) => Promise<string>
): Promise<string[]> {
  const problems: string[] = [];
  for (const database of databases) {
    for (const login of logins) {
      const outcome = await attempt(database, login.name, login.password);
      if (outcome !== '28000') {
        problems.push(
          `login ${login.name} was not refused by pg_hba at database ${database} (got ${outcome})`
        );
      }
    }
  }
  return problems;
}
