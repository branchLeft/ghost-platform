import { execFile } from 'node:child_process';
import { dockerRemoveSync, processCleanup, type CleanupRegistry } from './cleanup.js';
import { withEnvFile } from './envFile.js';

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
  /** The run's own network, shared with the scratch database and nothing else. */
  readonly network: string | null;
}

/** A colour spec before its env file exists: the runner writes that at start. */
export type TenantColourTemplate = Omit<TenantColourSpec, 'envFile'>;

/** What a run adds to the colour's template: the copy's network and volumes. */
export interface ColourAttachments {
  readonly network: string | null;
  readonly volumes: readonly VolumeMount[];
}

export interface ContainerRunner {
  /** Starts the colour with exactly `env` as its environment. */
  start(
    env: Readonly<Record<string, string>>,
    attach?: ColourAttachments
  ): Promise<{ baseUrl: string }>;
  /** The environment the running colour was actually given, read back from Docker. */
  readEnv(): Promise<Readonly<Record<string, string>>>;
  stop(): Promise<void>;
}

/**
 * Every container in a run that carries tenant data on stdout or stderr --
 * the dump, the scratch database, the status probe, the SQLite backup, the
 * export colour, the relay -- runs with no log driver. Docker's default
 * json-file driver would otherwise write that output, uncapped, to
 * /var/lib/docker on the shared host. Attached stdout (what `docker run`
 * without `-d` prints) still reaches the caller: the log driver only decides
 * what Docker keeps.
 */
export const NO_CONTAINER_LOGS: readonly string[] = ['--log-driver', 'none'];

export function tenantContainerArgs(config: TenantContainerConfig): string[] {
  const args = [...NO_CONTAINER_LOGS, '--env-file', config.envFile];
  if (config.user !== null) args.push('--user', config.user);
  for (const mount of config.volumes) {
    const ro = mount.readOnly ? ',readonly' : '';
    args.push('--mount', `type=volume,src=${mount.volume},dst=${mount.mountPath}${ro}`);
  }
  return args;
}

/**
 * LLD-8 §08b: "The tenant's image is started on the tenant's data with no
 * route pointed at it." On the run's own network (always, in production)
 * the colour publishes nothing: that network is `--internal`, so it has no
 * route out of the host and Docker publishes no port for it. The relay below
 * is its one way in, bound to `127.0.0.1`. Without a network the colour
 * publishes on `127.0.0.1` itself -- never `0.0.0.0` -- as
 * render-core/test/live-demo-boot.test.ts proves for a demo colour.
 */
export function buildDockerRunArgs(spec: TenantColourSpec): readonly string[] {
  const args: string[] = ['run', '-d', '--name', spec.containerName];
  if (spec.network !== null) {
    args.push('--network', spec.network);
  } else {
    args.push('-p', `127.0.0.1:${spec.loopbackPort}:2368`);
  }
  args.push(...tenantContainerArgs(spec));
  args.push(spec.image);
  return args;
}

export function relayNames(containerName: string): { relay: string; edge: string } {
  return { relay: `${containerName}-relay`, edge: `${containerName}-edge` };
}

/**
 * Forwards one loopback port to the colour on the internal network, and does
 * nothing else: no environment, no volume, no tenant data at rest.
 */
export const RELAY_SCRIPT =
  "const net=require('net');const target=process.argv[1];" +
  'net.createServer((c)=>{const u=net.connect(2368,target);c.pipe(u);u.pipe(c);' +
  "c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());}).listen(2368,'0.0.0.0');";

export function buildRelayRunArgs(spec: TenantColourTemplate): readonly string[] {
  const { relay, edge } = relayNames(spec.containerName);
  return [
    'run',
    '-d',
    '--name',
    relay,
    '--network',
    edge,
    '-p',
    `127.0.0.1:${spec.loopbackPort}:2368`,
    ...NO_CONTAINER_LOGS,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    // The relay is one Node process forwarding one TCP port to the colour;
    // these bound it far above that one job, not size it to it, so a bug in
    // the relay script (or in the tenant's own image it runs from) can't
    // turn the relay into a fork bomb or a memory sink on the shared host.
    '--pids-limit',
    '16',
    '--memory',
    '64m',
    '--user',
    'node',
    '--entrypoint',
    'node',
    spec.image,
    '-e',
    RELAY_SCRIPT,
    spec.containerName,
  ];
}

export function buildDockerStopArgs(containerName: string): readonly string[] {
  return ['rm', '-f', containerName];
}

export function buildDockerInspectEnvArgs(containerName: string): readonly string[] {
  return ['inspect', '--format', '{{json .Config.Env}}', containerName];
}

/** Docker's `KEY=VALUE` list, as a map; the first `=` splits. */
export function parseInspectedEnv(stdout: string): Record<string, string> {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('docker inspect did not return an env list');
  const env: Record<string, string> = {};
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

export function runDocker(dockerCommand: string, argv: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Explicit, minimal env: PATH only, never the ambient environment this
    // shell carries (which holds live production credentials this process
    // has no business handing to `docker`).
    execFile(
      dockerCommand,
      [...argv],
      { env: { PATH: process.env.PATH ?? '' }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Never err.message: it repeats the whole argv, env values included.
          reject(new Error(`docker ${argv[0]} failed (exit ${String(err.code)}): ${stderr}`));
          return;
        }
        resolve(stdout);
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
  template: TenantColourTemplate,
  dockerCommand = 'docker',
  registry: CleanupRegistry = processCleanup
): ContainerRunner {
  const { relay, edge } = relayNames(template.containerName);
  let relayed = false;
  let unregister: (() => void) | undefined;

  const removeRelaySync = () => {
    for (const argv of [buildDockerStopArgs(relay), ['network', 'rm', edge]]) {
      try {
        dockerRemoveSync(argv, dockerCommand);
      } catch {
        // Already gone, or never created.
      }
    }
  };
  const removeAllSync = () => {
    try {
      dockerRemoveSync(buildDockerStopArgs(template.containerName), dockerCommand);
    } catch {
      // Already gone, or never created.
    }
    if (relayed) removeRelaySync();
  };

  return {
    async start(env, attach) {
      const spec = {
        ...template,
        network: attach?.network ?? template.network,
        volumes: [...template.volumes, ...(attach?.volumes ?? [])],
      };
      relayed = spec.network !== null;
      // Registered before `docker run`, so a signal mid-start still removes it.
      unregister = registry.register(`export colour ${template.containerName}`, removeAllSync);
      try {
        await withEnvFile(
          env,
          (envFile) => runDocker(dockerCommand, buildDockerRunArgs({ ...spec, envFile })),
          registry
        );
        if (spec.network !== null) {
          await runDocker(dockerCommand, ['network', 'create', edge]);
          await runDocker(dockerCommand, buildRelayRunArgs(spec));
          await runDocker(dockerCommand, ['network', 'connect', spec.network, relay]);
        }
      } catch (err) {
        // `docker run -d` can create the container and then fail to start
        // it; the created container still holds the colour's environment.
        removeAllSync();
        unregister();
        throw err;
      }
      return { baseUrl: `http://127.0.0.1:${template.loopbackPort}` };
    },
    async readEnv() {
      return parseInspectedEnv(
        await runDocker(dockerCommand, buildDockerInspectEnvArgs(template.containerName))
      );
    },
    async stop() {
      if (relayed) removeRelaySync();
      await runDocker(dockerCommand, buildDockerStopArgs(template.containerName));
      unregister?.();
    },
  };
}
