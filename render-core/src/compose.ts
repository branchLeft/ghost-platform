/**
 * The Compose stack one tenant runs on a shared app host — ported and
 * extended from `infra/tenant/compose.ts`. Renders both blue/green services
 * from one descriptor, and demo slots bind to loopback rather than `appHostIp`.
 * See compose.md.
 */

import { FieldValidationError, validatePrivateIpV4 } from './brand.js';
import type { ResourceCaps, TenantDescriptor } from './descriptor.js';
import type { UploadLimits } from './runtime.js';
import { METRICS_MOUNT_PATH, VERDICT_MOUNT_PATH, VERDICT_SOCKET_PATH } from './environment.js';
import {
  adaptersVolumeName,
  contentVolumeName,
  metricsVolumeName,
  stackName,
  verdictJournalVolumeName,
  verdictNetworkName,
} from './naming.js';
import type { YamlValue } from './yaml.js';
import { toYaml } from './yaml.js';

/** Ghost's own listening port inside the container. */
export const GHOST_CONTAINER_PORT = 2368;

/** See `infra/tenant/compose.ts`'s own comment: a healthcheck probe of `/`
 * must carry this header or Ghost answers with a redirect `wget` cannot
 * follow, forever. */
const HEALTHCHECK_FORWARDED_PROTO = 'X-Forwarded-Proto: https';

/**
 * How long a `stop` of a Ghost container waits before Docker sends SIGKILL.
 * Docker's own default is 10 seconds, too short to let an in-flight send
 * batch finish. This first value is a provisional assumption: the issue names
 * no batch duration, so 60 seconds is six times Docker's default. It is to be
 * replaced by the value the two-instance harness measures. See
 * compose.md#the-stop-grace-period.
 */
export const GHOST_STOP_GRACE_PERIOD = '60s';

const CONTENT_MOUNT_PATH = '/var/lib/ghost/content';
const ADAPTERS_MOUNT_PATH = `${CONTENT_MOUNT_PATH}/adapters`;

/** The service name of a slot's verdict host end. See
 * compose.md#the-verdict-host-sidecar. */
export const VERDICT_HOST_SERVICE = 'verdict-host';

/**
 * Where the image carries the verdict host end: the `adapters/scanning-storage`
 * tree, `src/` and `verdict-host/` side by side, because the host end requires
 * `../src/verdict-socket-frame`. The image does not carry it yet (the
 * `Dockerfile` copies `src/` only); until it does, the sidecar fails to start
 * and the descriptor switch stays off. See compose.md#the-verdict-host-sidecar.
 */
export const VERDICT_HOST_ENTRYPOINT = '/opt/branchleft/scanning-storage/verdict-host/main.js';

/** Where the sidecar mounts its own journal volume, read-write. */
export const VERDICT_HOST_STATE_PATH = '/var/lib/verdict-host';

/**
 * The sidecar's resource limits. A small queue process, not a Ghost: it holds
 * at most 10,000 PDQ hashes and serves a handful of connections.
 */
export const VERDICT_HOST_LIMITS = {
  tmpfsSize: '16m',
  memoryLimit: '192m',
  cpus: '0.5',
  cpuShares: 256,
  pidsLimit: 64,
  nofile: 1024,
  stopGracePeriod: '10s',
} as const;

/** Loopback: what every demo slot binds to instead of `appHostIp` — see the
 * module doc comment's "Load-bearing" note. */
const DEMO_BIND_ADDRESS = '127.0.0.1';

/**
 * Where a demo's SQLite file and local media directory are mounted from —
 * `database.path`'s and `media.path`'s own common parent, computed by
 * `render.ts` (which is where both paths are already validated against
 * each other) and passed through rather than recomputed here.
 */
export interface DemoDataMount {
  /** Host-provisioned once, at demo-host build time (LLD-2 §01, matching
   * how the rest of a slot's fixed resources are provisioned) — named by
   * `uid`, the stable per-slot identity, never by `slug` (a demo's slug is
   * a throwaway per-lease value; see `lease.ts`'s own doc comment). */
  readonly volumeName: string;
  readonly path: string;
}

export interface ComposeStackArgs {
  readonly kind: TenantDescriptor['kind'];
  readonly slug: TenantDescriptor['slug'];
  readonly uid: TenantDescriptor['uid'];
  readonly appHostPrivateIp: TenantDescriptor['appHostIp'];
  readonly ports: TenantDescriptor['ports'];
  readonly environment: Record<string, string | number | boolean>;
  readonly limits: UploadLimits;
  readonly caps: ResourceCaps;
  /** Non-null exactly for a `sqlite` + `local` (demo) descriptor. */
  readonly dataMount: DemoDataMount | null;
  /** The host spool's internal network for this tenant, non-null exactly
   * when mail is enabled. See compose.md#the-mail-network. */
  readonly mailNetwork: string | null;
  /**
   * Optional. The slot's verdict volume, non-null exactly when its
   * descriptor names the production verdict source; mounted read-only in
   * both colours. See compose.md#the-verdict-volume.
   */
  readonly verdictVolume?: string | null;
  /**
   * Optional. When present, only this colour's Ghost service is rendered and
   * the idle colour is omitted from the document; when absent, both colours
   * are rendered, exactly as before. See compose.md#one-running-colour.
   */
  readonly activeColour?: Colour;
}

/** The two slot colours a blue/green deploy swaps between. */
export type Colour = 'a' | 'b';

const COLOURS: readonly Colour[] = ['a', 'b'];

function coloursToRender(activeColour: Colour | undefined): readonly Colour[] {
  if (activeColour === undefined) return COLOURS;
  if (!COLOURS.includes(activeColour)) {
    throw new FieldValidationError(
      'activeColour',
      `activeColour must be "a" or "b" when given, got ${JSON.stringify(activeColour)}.`
    );
  }
  return [activeColour];
}

/** The address every published port binds to — see the module doc
 * comment's "Load-bearing" note. */
function bindAddress(args: ComposeStackArgs): string {
  return args.kind === 'demo' ? DEMO_BIND_ADDRESS : args.appHostPrivateIp;
}

function ghostService(
  args: ComposeStackArgs,
  colour: Colour,
  content: string,
  adapters: string,
  metrics: string | null,
  verdict: string | null
): Record<string, YamlValue> {
  const hostPort = colour === 'a' ? args.ports.a : args.ports.b;
  const volumes = [`${content}:${CONTENT_MOUNT_PATH}`, `${adapters}:${ADAPTERS_MOUNT_PATH}:ro`];
  if (metrics !== null) {
    // Read-write, on purpose: the tenant's own process creates and rewrites
    // the scanner's metrics file here. See compose.md#the-metrics-volume.
    volumes.push(`${metrics}:${METRICS_MOUNT_PATH}`);
  }
  if (verdict !== null) {
    // Read-only, on purpose: Ghost only dials the socket, which a read-only
    // mount allows, and must not replace it or touch anything beside it.
    // See compose.md#the-verdict-volume.
    volumes.push(`${verdict}:${VERDICT_MOUNT_PATH}:ro`);
  }
  if (args.dataMount) {
    volumes.push(`${args.dataMount.volumeName}:${args.dataMount.path}`);
  }
  return {
    image: '${IMAGE}',
    restart: 'unless-stopped',
    stop_grace_period: GHOST_STOP_GRACE_PERIOD,
    // Distinct per tenant, never reused — the one control that separates
    // one tenant's data from another's on a shared host.
    user: `${args.uid}:${args.uid}`,
    init: true,
    read_only: true,
    tmpfs: [`/tmp:rw,noexec,nosuid,nodev,size=${args.limits.tmpfsSize}`],
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    pids_limit: args.caps.pidsLimit,
    mem_limit: args.limits.memoryLimit,
    memswap_limit: args.limits.memoryLimit,
    cpus: args.caps.cpus,
    cpu_shares: args.caps.cpuShares,
    ulimits: {
      nofile: { soft: args.caps.nofile, hard: args.caps.nofile },
    },
    logging: {
      driver: 'json-file',
      options: { 'max-size': '10m', 'max-file': '3' },
    },
    ports: [`${bindAddress(args)}:${hostPort}:${GHOST_CONTAINER_PORT}`],
    environment: args.environment as YamlValue,
    ...(args.mailNetwork ? { networks: ['default', args.mailNetwork] } : {}),
    volumes,
    healthcheck: {
      test: [
        'CMD',
        'wget',
        '-q',
        '-O',
        '/dev/null',
        '--header',
        HEALTHCHECK_FORWARDED_PROTO,
        `http://127.0.0.1:${GHOST_CONTAINER_PORT}/`,
      ],
      interval: '30s',
      timeout: '5s',
      retries: 3,
      start_period: '60s',
    },
  };
}

/**
 * The per-slot verdict host end, from the same digest-pinned image as Ghost.
 * It joins one network and no other, `internal: true`, so an outbound connect
 * has no route; it publishes no port. The posture matches Ghost's. See
 * compose.md#the-verdict-host-sidecar.
 */
function verdictHostService(
  args: ComposeStackArgs,
  verdict: string,
  journal: string,
  network: string
): Record<string, YamlValue> {
  return {
    image: '${IMAGE}',
    restart: 'unless-stopped',
    stop_grace_period: VERDICT_HOST_LIMITS.stopGracePeriod,
    // The slot's own uid for now. A uid of its own, and a group Ghost shares
    // for the socket, are the per-slot socket identity's, not this render's.
    user: `${args.uid}:${args.uid}`,
    init: true,
    read_only: true,
    tmpfs: [`/tmp:rw,noexec,nosuid,nodev,size=${VERDICT_HOST_LIMITS.tmpfsSize}`],
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    pids_limit: VERDICT_HOST_LIMITS.pidsLimit,
    mem_limit: VERDICT_HOST_LIMITS.memoryLimit,
    memswap_limit: VERDICT_HOST_LIMITS.memoryLimit,
    cpus: VERDICT_HOST_LIMITS.cpus,
    cpu_shares: VERDICT_HOST_LIMITS.cpuShares,
    ulimits: {
      nofile: { soft: VERDICT_HOST_LIMITS.nofile, hard: VERDICT_HOST_LIMITS.nofile },
    },
    logging: {
      driver: 'json-file',
      options: { 'max-size': '10m', 'max-file': '3' },
    },
    // The image's own entrypoint starts Ghost; this one starts the host end.
    entrypoint: ['node', VERDICT_HOST_ENTRYPOINT],
    // The verify key file and the inbound port are the descriptor and edge
    // route's, not this render's: the host end refuses to start without
    // them, so it never runs half-configured.
    environment: {
      VERDICT_HOST_SOCKET: VERDICT_SOCKET_PATH,
      VERDICT_HOST_JOURNAL: `${VERDICT_HOST_STATE_PATH}/queue.journal`,
      VERDICT_HOST_METRICS_FILE: `${VERDICT_HOST_STATE_PATH}/verdict-host.prom`,
    },
    networks: [network],
    // Read-write here, read-only in Ghost: the host end creates the socket.
    volumes: [`${verdict}:${VERDICT_MOUNT_PATH}`, `${journal}:${VERDICT_HOST_STATE_PATH}`],
    healthcheck: {
      test: ['CMD', 'test', '-S', VERDICT_SOCKET_PATH],
      interval: '30s',
      timeout: '5s',
      retries: 3,
      start_period: '30s',
    },
  };
}

/** The stack as a document, before the posture check and the header. Exported
 * for the render tests, which assert on the structure rather than the text; not
 * part of the package's public surface (`index.ts` does not re-export it). */
export function composeDocument(args: ComposeStackArgs): Record<string, YamlValue> {
  const content = contentVolumeName(args.slug);
  const adapters = adaptersVolumeName(args.slug);
  // Exactly the condition under which `environment.ts` renders the metrics
  // keys (a paying tenant, whose media is always object storage): a demo
  // mounts no metrics volume and names no metrics key.
  const metrics = args.kind === 'demo' ? null : metricsVolumeName(args.slug);
  const verdict = args.verdictVolume ?? null;

  const volumes: Record<string, YamlValue> = {
    [content]: { external: true },
    [adapters]: { external: true },
  };
  if (metrics !== null) {
    volumes[metrics] = { external: true };
  }
  const journal = verdict === null ? null : verdictJournalVolumeName(args.slug);
  const verdictNetwork = verdict === null ? null : verdictNetworkName(args.slug);
  if (verdict !== null && journal !== null) {
    volumes[verdict] = { external: true };
    volumes[journal] = { external: true };
  }
  if (args.dataMount) {
    volumes[args.dataMount.volumeName] = { external: true };
  }

  const services: Record<string, YamlValue> = Object.fromEntries(
    coloursToRender(args.activeColour).map((colour) => [
      `ghost-${colour}`,
      ghostService(args, colour, content, adapters, metrics, verdict),
    ])
  );
  const networks: Record<string, YamlValue> = {};
  if (args.mailNetwork) {
    networks[args.mailNetwork] = { name: args.mailNetwork, external: true };
  }
  if (verdict !== null && journal !== null && verdictNetwork !== null) {
    // Both colours use the one sidecar, so it is rendered whichever colours
    // are, and a one-colour render keeps it from being removed as an orphan.
    services[VERDICT_HOST_SERVICE] = verdictHostService(args, verdict, journal, verdictNetwork);
    // Owned by this file, never `external`, so `internal` is what Docker
    // applies: no gateway, no NAT, no route off the network.
    networks[verdictNetwork] = { name: verdictNetwork, internal: true };
  }

  return {
    name: stackName(args.slug),
    services,
    ...(Object.keys(networks).length > 0 ? { networks } : {}),
    // `external: true`: the host-side provisioning step creates and owns
    // these volumes before this stack ever starts — see
    // `infra/tenant/compose.ts`'s own comment on why Compose must never be
    // the thing that first populates one.
    volumes,
  };
}

function header(slug: TenantDescriptor['slug']): string {
  return [
    `# The ${slug} Ghost stack, deployed as \`${stackName(slug)}\` under`,
    `# /opt/branchleft/${stackName(slug)} on an app host.`,
    '#',
    '# Rendered by @branchleft/ghost-platform-render-core. Do not hand-edit on',
    '# the host: every line below is a runtime-isolation control, and a stack',
    '# that omits one still starts, still serves, and silently drops the',
    '# boundary.',
    '#',
    '# `${IMAGE}` is written to /etc/branchleft/<stack>.image.env by',
    '# /usr/local/sbin/branchleft-deploy and is always a digest, never a tag.',
    '# Any `${GHOST_*}` reference comes from /etc/branchleft/<stack>.env,',
    '# which is root-owned 0600 and written by an operator alone.',
  ].join('\n');
}

export function renderComposeStack(args: ComposeStackArgs): string {
  const document = composeDocument(args);
  assertRuntimePosture(document, bindAddress(args));
  return `${header(args.slug)}\n${toYaml(document)}`;
}

/** Container paths and options no tenant stack may ever carry. */
const FORBIDDEN_SERVICE_KEYS = [
  'privileged',
  'cap_add',
  'devices',
  'device_cgroup_rules',
  'network_mode',
  'pid',
  'ipc',
  'userns_mode',
  'cgroup',
  'cgroup_parent',
  'external_links',
] as const;

const FORBIDDEN_SECURITY_OPTS = [
  'seccomp=unconfined',
  'apparmor=unconfined',
  'systempaths=unconfined',
];

const SHELL_SENDS_HEADER = /--header[= ]\s*(['"])X-Forwarded-Proto:\s*https\1/;

type HealthProbe =
  { kind: 'missing' | 'disabled' | 'malformed' } | { kind: 'ok'; sendsHeader: boolean };

function healthProbe(service: Record<string, YamlValue>): HealthProbe {
  const healthcheck = service.healthcheck;
  const test =
    typeof healthcheck === 'object' && healthcheck !== null && !Array.isArray(healthcheck)
      ? (healthcheck as Record<string, YamlValue>).test
      : undefined;

  if (typeof test === 'string') {
    if (test.trim().length === 0) return { kind: 'missing' };
    return { kind: 'ok', sendsHeader: SHELL_SENDS_HEADER.test(test) };
  }
  if (test === undefined) return { kind: 'missing' };
  if (!Array.isArray(test)) return { kind: 'malformed' };
  if (test.length === 0) return { kind: 'missing' };
  if (!test.every((element): element is string => typeof element === 'string')) {
    return { kind: 'malformed' };
  }

  const [form, ...rest] = test as string[];
  if (form === 'NONE') return { kind: 'disabled' };
  if (form === 'CMD-SHELL') {
    const command = rest.join(' ');
    if (command.trim().length === 0) return { kind: 'missing' };
    return { kind: 'ok', sendsHeader: SHELL_SENDS_HEADER.test(command) };
  }
  if (form !== 'CMD') return { kind: 'malformed' };
  if (rest.length === 0) return { kind: 'missing' };
  return {
    kind: 'ok',
    sendsHeader: rest.some(
      (element, index) =>
        element === `--header=${HEALTHCHECK_FORWARDED_PROTO}` ||
        (element === '--header' && rest[index + 1] === HEALTHCHECK_FORWARDED_PROTO)
    ),
  };
}

/**
 * Re-reads the finished document and refuses anything outside the runtime
 * posture, for every service it declares — ported unchanged in substance
 * from `infra/tenant/compose.ts#assertRuntimePosture`, which already
 * iterated `document.services` generically rather than naming `'ghost'`,
 * so it applies to `ghost-a`/`ghost-b` with no change of its own. A posture
 * with no test for its absence is a comment; this runs inside
 * `renderComposeStack`, so there is no rendered stack that reaches a
 * consumer without having passed it.
 */
export function assertRuntimePosture(
  document: Record<string, YamlValue>,
  expectedBindAddress: string
): void {
  // Validated here rather than taken on trust: every port check below
  // compares the rendered ports against this value, and an unchecked
  // `expectedBindAddress` of `0.0.0.0` would produce `0.0.0.0:<port>:2368`,
  // which passes a naive comparison against itself. Loopback is the one
  // exception to `validatePrivateIpV4` — a demo's own load-bearing bind
  // address (see the module doc comment) — checked explicitly rather than
  // relaxing the shared validator, which must stay strict for every other
  // caller (`appHostIp` itself is never legitimately loopback).
  if (expectedBindAddress !== '127.0.0.1') {
    validatePrivateIpV4(expectedBindAddress);
  }

  const services = document.services as Record<string, Record<string, YamlValue>>;
  const problems: string[] = [];

  for (const [name, service] of Object.entries(services)) {
    const at = (message: string) => problems.push(`service "${name}": ${message}`);

    for (const key of FORBIDDEN_SERVICE_KEYS) {
      if (key in service) at(`must not set \`${key}\``);
    }

    if (service.read_only !== true) at('must set `read_only: true`');
    if (service.init !== true) at('must set `init: true`');
    if (typeof service.user !== 'string' || !/^\d+:\d+$/.test(service.user)) {
      at('must run as a numeric per-tenant `user: "<uid>:<uid>"`');
    }
    if (!Array.isArray(service.cap_drop) || !service.cap_drop.includes('ALL')) {
      at('must set `cap_drop: [ALL]`');
    }

    const securityOpt = Array.isArray(service.security_opt) ? service.security_opt : [];
    if (!securityOpt.includes('no-new-privileges:true')) {
      at('must set `security_opt: [no-new-privileges:true]`');
    }
    for (const opt of securityOpt) {
      if (typeof opt === 'string' && FORBIDDEN_SECURITY_OPTS.includes(opt.toLowerCase())) {
        at(`must not opt out of a shipped default (\`${opt}\`)`);
      }
    }

    if (typeof service.pids_limit !== 'number') at('must set `pids_limit`');
    if (typeof service.mem_limit !== 'string') at('must set `mem_limit`');
    if (service.memswap_limit !== service.mem_limit) {
      at('must set `memswap_limit` equal to `mem_limit`, or swap is unbounded');
    }
    if (typeof service.cpus !== 'string') at('must set `cpus`');
    const grace = service.stop_grace_period;
    if (typeof grace !== 'string' || !/^\d+s$/.test(grace)) {
      at('must set `stop_grace_period` to whole seconds, or a stop kills Ghost mid-batch');
    }

    const logging = service.logging as Record<string, YamlValue> | undefined;
    const loggingOptions = logging?.options as Record<string, YamlValue> | undefined;
    if (!loggingOptions?.['max-size'] || !loggingOptions?.['max-file']) {
      at('must bound its json-file logs with `max-size` and `max-file`');
    }

    const ports = Array.isArray(service.ports) ? service.ports : [];
    if (name === VERDICT_HOST_SERVICE) {
      // The verdict host end is reached over its network and its socket
      // volume, never a published port.
      if ('ports' in service) at('must publish no port: it has no `ports` key at all');
      if ('expose' in service) at('must not set `expose`');
    }
    for (const port of ports) {
      const parts = typeof port === 'string' ? port.split(':') : [];
      if (parts.length !== 3 || parts[0] !== expectedBindAddress) {
        at(
          `publishes \`${String(port)}\` — every port must be ` +
            `<app-host-private-ip>:<host-port>:<container-port>`
        );
        continue;
      }
      const hostPort = Number(parts[1]);
      if (!/^\d+$/.test(parts[1]) || !Number.isInteger(hostPort)) {
        at(`publishes \`${String(port)}\` — the host port is not a number`);
      }
    }

    const probe = healthProbe(service);
    if (probe.kind === 'missing') at('must declare a `healthcheck.test`');
    if (probe.kind === 'disabled') at('must not disable its healthcheck with `test: [NONE]`');
    if (probe.kind === 'malformed') {
      at('declares a `healthcheck.test` that is not a string, `CMD` or `CMD-SHELL` form');
    }
    // The verdict host end is not Ghost: it serves no page, so the Ghost
    // probe's header means nothing to it.
    if (probe.kind === 'ok' && !probe.sendsHeader && name !== VERDICT_HOST_SERVICE) {
      at(
        `must bind \`${HEALTHCHECK_FORWARDED_PROTO}\` to \`--header\` in its healthcheck, or Ghost ` +
          `answers the probe with a 301 to HTTPS that it cannot follow`
      );
    }

    const volumes = Array.isArray(service.volumes) ? service.volumes : [];
    for (const volume of volumes) {
      if (typeof volume !== 'string' || volume.startsWith('/') || volume.startsWith('.')) {
        at(`mounts \`${String(volume)}\` — only named volumes, never a host path`);
      } else if (volume.includes('docker.sock')) {
        at('must never receive the Docker socket');
      }
    }
  }

  checkVerdictHostNetwork(document, services, problems);

  if (problems.length > 0) {
    throw new Error(
      `render(): rendered stack violates the runtime posture:\n- ${problems.join('\n- ')}`
    );
  }
}

function asRecord(value: YamlValue | undefined): Record<string, YamlValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, YamlValue>)
    : undefined;
}

/** The network names a service lists, whether as a list or a map; null when
 * it lists none, which Compose reads as the stack's `default` network. */
function serviceNetworkNames(service: Record<string, YamlValue>): string[] | null {
  const networks = service.networks;
  if (Array.isArray(networks)) {
    return networks.filter((n): n is string => typeof n === 'string');
  }
  const record = asRecord(networks);
  return record ? Object.keys(record) : null;
}

/**
 * The verdict host end's network deny. It must list exactly one network, that
 * network must be declared in this file, `internal: true`, not `external` and
 * not IPv6, and no other service may join it. A network that is not internal
 * gives the process a gateway, and "never dials out" would rest on code alone.
 */
function checkVerdictHostNetwork(
  document: Record<string, YamlValue>,
  services: Record<string, Record<string, YamlValue>>,
  problems: string[]
): void {
  const sidecar = services[VERDICT_HOST_SERVICE];
  if (sidecar === undefined) return;
  const at = (message: string) => problems.push(`service "${VERDICT_HOST_SERVICE}": ${message}`);

  const names = serviceNetworkNames(sidecar);
  if (names === null || names.length !== 1) {
    at(
      'must list exactly one network, an `internal: true` one of its own; with none it joins ' +
        'the default network, which has egress'
    );
    return;
  }
  const [network] = names;
  const topLevel = asRecord(document.networks) ?? {};
  const declared = asRecord(topLevel[network]);
  if (declared === undefined) {
    at(`joins network "${network}", which the file does not declare`);
  } else {
    if (declared.internal !== true) {
      at(
        `joins network "${network}", which is not \`internal: true\`: a network with a gateway ` +
          'gives it a route off the host'
      );
    }
    if (declared.external === true) {
      at(
        `network "${network}" must be owned by this file, or \`internal\` is not what Docker applies`
      );
    }
    if (declared.enable_ipv6 !== undefined && declared.enable_ipv6 !== false) {
      at(
        `network "${network}" must not set \`enable_ipv6\`: it is a route the IPv4 reasoning misses`
      );
    }
  }

  for (const [name, service] of Object.entries(services)) {
    if (name === VERDICT_HOST_SERVICE) continue;
    if (serviceNetworkNames(service)?.includes(network)) {
      problems.push(`service "${name}": must not join the verdict host's network "${network}"`);
    }
  }
}
