// Docker, called as a program with an argument list: no shell, so a name or a
// path is never parsed as anything but itself. Everything here talks to the
// local daemon only.

import { execFile } from 'node:child_process';

export class DockerError extends Error {}

export function docker(
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      [...args],
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new DockerError(
              `docker ${args.slice(0, 2).join(' ')} failed: ${stderr.trim().slice(0, 500) || error.message}`
            )
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export interface InspectedImage {
  readonly imageId: string;
  readonly repoDigests: readonly string[];
}

export async function inspectImage(reference: string): Promise<InspectedImage> {
  const out = await docker([
    'image',
    'inspect',
    reference,
    '--format',
    '{{.Id}}\t{{json .RepoDigests}}',
  ]);
  const [id, digests] = out.trim().split('\t');
  if (id === undefined || digests === undefined)
    throw new DockerError(`image ${reference} could not be inspected`);
  return { imageId: id, repoDigests: JSON.parse(digests) as string[] };
}

/** The image id a running container was started from. */
export async function containerImageId(name: string): Promise<string> {
  return (await docker(['inspect', name, '--format', '{{.Image}}'])).trim();
}

export async function removeAll(prefix: string): Promise<void> {
  const containers = (await docker(['ps', '-aq', '--filter', `name=^${prefix}`]))
    .split('\n')
    .filter(Boolean);
  if (containers.length > 0) await docker(['rm', '-f', ...containers]);
  const networks = (await docker(['network', 'ls', '-q', '--filter', `name=^${prefix}`]))
    .split('\n')
    .filter(Boolean);
  for (const n of networks) await docker(['network', 'rm', n]);
}

/** The digest-pinned base images a Dockerfile builds from, as `name@sha256:<64 hex>`. */
export function pinnedBases(dockerfile: string): string[] {
  const found: string[] = [];
  for (const line of dockerfile.split('\n')) {
    const match = /^FROM\s+(?:--platform=\S+\s+)?(\S+@sha256:[0-9a-f]{64})(?:\s|$)/i.exec(line);
    if (match?.[1] !== undefined && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}
