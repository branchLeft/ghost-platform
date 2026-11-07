import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FakeDockerOptions {
  readonly fail?: boolean;
  readonly argvLogPath?: string;
  readonly envProbeLogPath?: string;
  readonly envProbeVar?: string;
  /** What `docker version --format ...` prints; every other call is unaffected. */
  readonly versionOutput?: string;
}

/**
 * A stand-in for the real `docker` binary, written fresh per test with its
 * output paths baked into the script text rather than read from the
 * environment -- runDocker()'s own `{ env: { PATH } }` deliberately replaces
 * the ambient environment for this child (see containerRunner.ts's comment),
 * so a fixture that needed an env var to know where to log would break
 * for the same reason it is safe. Mirrors
 * services/broker/test/helpers/fakeWrapper.mjs's role, adapted for a
 * child that gets no env at all.
 */
export async function writeFakeDocker(dir: string, opts: FakeDockerOptions): Promise<string> {
  const scriptPath = join(dir, 'fake-docker.sh');
  const lines = ['#!/bin/sh'];
  if (opts.fail) {
    lines.push('echo "fake docker: forced failure" >&2', 'exit 1');
  } else {
    if (opts.argvLogPath) {
      lines.push(
        `printf '[' >> '${opts.argvLogPath}'`,
        'first=1',
        'for arg in "$@"; do',
        `  if [ "$first" = 1 ]; then first=0; else printf ',' >> '${opts.argvLogPath}'; fi`,
        `  printf '"%s"' "$arg" >> '${opts.argvLogPath}'`,
        'done',
        `printf ']\\n' >> '${opts.argvLogPath}'`
      );
    }
    if (opts.envProbeLogPath && opts.envProbeVar) {
      lines.push(
        `if [ -n "$${opts.envProbeVar}" ]; then echo present > '${opts.envProbeLogPath}'; else echo absent > '${opts.envProbeLogPath}'; fi`
      );
    }
    if (opts.versionOutput !== undefined) {
      lines.push(`if [ "$1" = version ]; then printf '%s\\n' '${opts.versionOutput}'; exit 0; fi`);
    }
    lines.push('exit 0');
  }
  await writeFile(scriptPath, lines.join('\n') + '\n');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}
