import { execFile } from 'node:child_process';
import { tenantContainerArgs, type TenantContainerConfig } from './containerRunner.js';
import type { SupportAccount, SupportAccountStatusReader } from './supportGrant.js';

export class SupportAccountStatusUnreadableError extends Error {
  constructor(detail: string) {
    super(
      `refused: the support account's status could not be read (${detail}); nothing was started`
    );
    this.name = 'SupportAccountStatusUnreadableError';
  }
}

export interface StatusProbeSpec extends TenantContainerConfig {
  readonly image: string;
}

const STATUS_MARKER = 'BL_SUPPORT_STATUS ';

/**
 * Runs inside the tenant's own image, through Ghost's own database
 * connection module, so it reads whatever database the tenant's colour
 * would (SQLite or MySQL, with the TLS settings rendered for Ghost) without
 * this package holding a driver or parsing a connection string. One SELECT
 * of the account's status and role names; nothing here writes.
 */
export const STATUS_PROBE_SCRIPT = [
  "process.chdir('/var/lib/ghost');",
  "const knex = require('/var/lib/ghost/current/core/server/data/db/connection');",
  "knex('users')",
  "  .leftJoin('roles_users', 'roles_users.user_id', 'users.id')",
  "  .leftJoin('roles', 'roles.id', 'roles_users.role_id')",
  "  .where('users.email', process.argv[1])",
  "  .select('users.status as status', 'roles.name as role')",
  '  .then((rows) => {',
  '    const account = rows.length === 0 ? null : {',
  '      status: rows[0].status,',
  '      roles: rows.map((r) => r.role).filter((r) => typeof r === "string"),',
  '    };',
  `    process.stdout.write('${STATUS_MARKER}' + JSON.stringify(account) + '\\n');`,
  '  })',
  "  .catch((err) => { process.stderr.write(String(err && err.message) + '\\n'); process.exitCode = 2; })",
  '  .finally(() => knex.destroy());',
].join('\n');

/**
 * A one-shot container of the tenant's image that runs the probe and
 * exits: no Ghost process, no published port, no drain flag. It runs as
 * the tenant's own user, with the tenant's own env file and volumes.
 */
export function buildStatusProbeArgs(spec: StatusProbeSpec, identity: string): readonly string[] {
  return [
    'run',
    '--rm',
    '--entrypoint',
    'node',
    ...tenantContainerArgs(spec),
    spec.image,
    '-e',
    STATUS_PROBE_SCRIPT,
    identity,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStatusProbeOutput(stdout: string): SupportAccount | null {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(STATUS_MARKER));
  if (line === undefined) {
    throw new SupportAccountStatusUnreadableError('the probe printed no status line');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(STATUS_MARKER.length));
  } catch {
    throw new SupportAccountStatusUnreadableError('the probe printed a malformed status line');
  }
  if (parsed === null) return null;
  if (
    !isRecord(parsed) ||
    typeof parsed.status !== 'string' ||
    !Array.isArray(parsed.roles) ||
    !parsed.roles.every((r) => typeof r === 'string')
  ) {
    throw new SupportAccountStatusUnreadableError('the probe printed an unexpected account shape');
  }
  return { status: parsed.status, roles: parsed.roles as string[] };
}

export function createDockerStatusProbe(
  spec: StatusProbeSpec,
  dockerCommand = 'docker'
): SupportAccountStatusReader {
  return {
    readAccount(identity) {
      return new Promise((resolve, reject) => {
        execFile(
          dockerCommand,
          [...buildStatusProbeArgs(spec, identity)],
          // PATH only: the ambient environment carries live credentials.
          { env: { PATH: process.env.PATH ?? '' } },
          (err, stdout, stderr) => {
            if (err) {
              // Never err.message: it repeats the whole argv.
              reject(
                new SupportAccountStatusUnreadableError(
                  `docker exited ${String(err.code)}: ${stderr.slice(0, 500)}`
                )
              );
              return;
            }
            try {
              resolve(parseStatusProbeOutput(stdout));
            } catch (parseErr) {
              reject(parseErr);
            }
          }
        );
      });
    },
  };
}
