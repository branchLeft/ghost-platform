import { execFile } from 'node:child_process';

export interface VolumeMount {
  readonly volume: string;
  readonly mountPath: string;
  readonly readOnly?: boolean;
}

/** How a container of the tenant's image is given the tenant's config. */
export interface TenantContainerConfig {
  /** A `docker --env-file`: env values never travel in argv, where `ps` shows them. */
  readonly envFile: string;
  /** The tenant's own `uid:gid` from its rendered stack; its content volume is private to it. */
  readonly user: string | null;
  readonly volumes: readonly VolumeMount[];
}

export interface TenantColourSpec extends TenantContainerConfig {
  readonly containerName: string;
  readonly image: string;
  /** Bound to loopback only -- see buildDockerRunArgs's own comment on why. */
  readonly loopbackPort: number;
}

export interface ContainerRunner {
  start(): Promise<{ baseUrl: string }>;
  stop(): Promise<void>;
}

export function tenantContainerArgs(config: TenantContainerConfig): string[] {
  const args = ['--env-file', config.envFile];
  if (config.user !== null) args.push('--user', config.user);
  for (const mount of config.volumes) {
    const ro = mount.readOnly ? ',readonly' : '';
    args.push('--mount', `type=volume,src=${mount.volume},dst=${mount.mountPath}${ro}`);
  }
  return args;
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
  args.push(...tenantContainerArgs(spec));
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
          // Never err.message: it repeats the whole argv, env values included.
          reject(new Error(`docker ${argv[0]} failed (exit ${String(err.code)}): ${stderr}`));
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
