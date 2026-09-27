import { execFile } from 'node:child_process';
import type { VolumeMount } from './containerRunner.js';
import type { SupportAccountStatusReader } from './supportGrant.js';

export class SupportAccountStatusUnreadableError extends Error {
  constructor(detail: string) {
    super(
      `refused: the support account's status could not be read (${detail}); nothing was started`
    );
    this.name = 'SupportAccountStatusUnreadableError';
  }
}

export interface StatusProbeSpec {
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly volumes: readonly VolumeMount[];
}

const STATUS_MARKER = 'BL_SUPPORT_STATUS ';

/**
 * Runs inside the tenant's own image, through Ghost's own database
 * connection module, so it reads whatever database the tenant's colour
 * would (SQLite or MySQL, with the TLS settings rendered for Ghost) without
 * this package holding a driver or parsing a connection string. One SELECT;
 * nothing here writes.
 */
export const STATUS_PROBE_SCRIPT = [
  "process.chdir('/var/lib/ghost');",
  "const knex = require('/var/lib/ghost/current/core/server/data/db/connection');",
  "knex('users').where({ email: process.argv[1] }).first('status')",
  `  .then((row) => { process.stdout.write('${STATUS_MARKER}' + JSON.stringify(row ? row.status : null) + '\\n'); })`,
  "  .catch((err) => { process.stderr.write(String(err && err.message) + '\\n'); process.exitCode = 2; })",
  '  .finally(() => knex.destroy());',
].join('\n');

/**
 * A one-shot container of the tenant's image that runs the probe and
 * exits: no Ghost process, no published port, no drain flag. It runs as
 * the image's `node` user so that a SQLite file it opens never gains a
 * root-owned sidecar the tenant's Ghost could not later write.
 */
export function buildStatusProbeArgs(spec: StatusProbeSpec, identity: string): readonly string[] {
  const args: string[] = ['run', '--rm', '--user', 'node', '--entrypoint', 'node'];
  for (const [key, value] of Object.entries(spec.env)) {
    args.push('-e', `${key}=${value}`);
  }
  for (const mount of spec.volumes) {
    args.push('--mount', `type=volume,src=${mount.volume},dst=${mount.mountPath}`);
  }
  args.push(spec.image, '-e', STATUS_PROBE_SCRIPT, identity);
  return args;
}

export function parseStatusProbeOutput(stdout: string): string | null {
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
  if (parsed !== null && typeof parsed !== 'string') {
    throw new SupportAccountStatusUnreadableError('the probe printed a non-string status');
  }
  return parsed;
}

export function createDockerStatusProbe(
  spec: StatusProbeSpec,
  dockerCommand = 'docker'
): SupportAccountStatusReader {
  return {
    readStatus(identity) {
      return new Promise((resolve, reject) => {
        execFile(
          dockerCommand,
          [...buildStatusProbeArgs(spec, identity)],
          // PATH only: the ambient environment carries live credentials.
          { env: { PATH: process.env.PATH ?? '' } },
          (err, stdout, stderr) => {
            if (err) {
              // Never err.message: it repeats the whole argv, env values included.
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
