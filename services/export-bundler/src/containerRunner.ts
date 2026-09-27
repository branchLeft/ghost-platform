import { execFile } from 'node:child_process';

export interface VolumeMount {
  readonly volume: string;
  readonly mountPath: string;
}

export interface TenantColourSpec {
  readonly containerName: string;
  readonly image: string;
  /** Bound to loopback only -- see buildDockerRunArgs's own comment on why. */
  readonly loopbackPort: number;
  readonly env: Readonly<Record<string, string>>;
  readonly volumes: readonly VolumeMount[];
}

export interface ContainerRunner {
  start(): Promise<{ baseUrl: string }>;
  stop(): Promise<void>;
}

/**
 * LLD-8 §08b: "The tenant's image is started on the tenant's data with no
 * route pointed at it." Binding the published port to `127.0.0.1` rather
 * than `0.0.0.0` is what makes "no route" true at the container boundary
 * itself, not merely at the edge's configuration -- the same reasoning
 * render-core/test/live-demo-boot.test.ts already proves for a demo colour
 * ("publishes only on 127.0.0.1 -- never on the descriptor's own private
 * appHostIp"), generalised here to an export colour, which LLD-4 §U7 calls
 * out as "additional... and transient": one export, one throwaway
 * container, never a ring member and never one of the tenant's own two
 * long-lived colours.
 */
export function buildDockerRunArgs(spec: TenantColourSpec): readonly string[] {
  const args: string[] = ['run', '-d', '--name', spec.containerName];
  args.push('-p', `127.0.0.1:${spec.loopbackPort}:2368`);
  for (const [key, value] of Object.entries(spec.env)) {
    args.push('-e', `${key}=${value}`);
  }
  for (const mount of spec.volumes) {
    args.push('--mount', `type=volume,src=${mount.volume},dst=${mount.mountPath}`);
  }
  args.push(spec.image);
  return args;
}

export function buildDockerStopArgs(containerName: string): readonly string[] {
  return ['rm', '-f', containerName];
}

function run(dockerCommand: string, argv: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // Explicit, minimal env: PATH only, never the ambient environment this
    // shell carries (which holds live production credentials this process
    // has no business handing to `docker`).
    execFile(
      dockerCommand,
      [...argv],
      { env: { PATH: process.env.PATH ?? '' } },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`docker ${argv[0]} failed: ${err.message}: ${stderr}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * `dockerCommand` defaults to the real binary; test/unit/containerRunner.test.ts
 * points it at a fixture script instead (mirroring
 * services/broker/test/helpers/fakeWrapper.mjs's own reasoning), so the
 * success and failure paths through `execFile` are proven without a real
 * Docker daemon -- a dependency no unit-test CI job here carries.
 */
export function createDockerContainerRunner(
  spec: TenantColourSpec,
  dockerCommand = 'docker'
): ContainerRunner {
  return {
    async start() {
      await run(dockerCommand, buildDockerRunArgs(spec));
      return { baseUrl: `http://127.0.0.1:${spec.loopbackPort}` };
    },
    async stop() {
      await run(dockerCommand, buildDockerStopArgs(spec.containerName));
    },
  };
}
