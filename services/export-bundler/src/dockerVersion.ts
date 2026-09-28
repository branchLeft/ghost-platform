import { execFile } from 'node:child_process';

/**
 * Below Docker 28, a container on an `--internal` network can still reach
 * the host's own address -- the isolation the run network
 * (scratchDatabase.ts's `--internal` network) is built on, and the only
 * thing standing between the export colour and the host once mail,
 * scheduling and the rest are switched off. There is no way to check the
 * app host's own Docker version from inside this package (no host access),
 * so the bundler checks the daemon it is actually talking to and refuses
 * before creating anything if that daemon is too old to trust.
 */
export const MINIMUM_DOCKER_SERVER_MAJOR_VERSION = 28;

export class DockerTooOldError extends Error {
  constructor(detail: string) {
    super(
      `refused: the Docker daemon ${detail} -- on Docker below ` +
        `${String(MINIMUM_DOCKER_SERVER_MAJOR_VERSION)} a container on an --internal network can ` +
        `still reach the host's own address, so the export bundler will not create anything`
    );
    this.name = 'DockerTooOldError';
  }
}

/** The first dot-separated component of a version string, as an integer. */
function majorVersion(version: string): number | null {
  const match = /^(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/**
 * `dockerCommand` defaults to the real binary; the unit test points it at a
 * fixture script, mirroring every other real-`docker`-command module here
 * (containerRunner.ts, scratchDatabase.ts).
 */
export function readDockerServerVersion(dockerCommand: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      dockerCommand,
      ['version', '--format', '{{.Server.Version}}'],
      // Explicit, minimal env, never the ambient environment -- see
      // containerRunner.ts's runDocker for why.
      { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Never err.message: it repeats the whole argv (see
          // containerRunner.ts's runDocker on the same point).
          reject(
            new DockerTooOldError(
              `could not be reached (docker version: ${stderr.trim() || 'no output'})`
            )
          );
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

/**
 * Refuses before anything is created unless the daemon's own reported
 * server version is at least {@link MINIMUM_DOCKER_SERVER_MAJOR_VERSION}. A
 * version this cannot parse fails closed the same as one that is too old --
 * an unreadable answer is never treated as a pass.
 */
export async function assertDockerServerSupported(dockerCommand = 'docker'): Promise<void> {
  const version = await readDockerServerVersion(dockerCommand);
  const major = majorVersion(version);
  if (major === null) {
    throw new DockerTooOldError(
      `reported an unreadable server version (${JSON.stringify(version)})`
    );
  }
  if (major < MINIMUM_DOCKER_SERVER_MAJOR_VERSION) {
    throw new DockerTooOldError(
      `reports server version ${version}, below the required ${String(MINIMUM_DOCKER_SERVER_MAJOR_VERSION)}`
    );
  }
}
