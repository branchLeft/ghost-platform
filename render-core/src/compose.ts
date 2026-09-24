/**
 * The Compose stack one tenant runs on a shared app host — ported and
 * extended from `infra/tenant/compose.ts`.
 *
 * **Load-bearing change from the ported module: two services, not one.**
 * LLD-1 §03b records the ruling behind `TenantDescriptor.ports` becoming a
 * `PortTriple` rather than a single port: "LLD-4 measured two Ghosts over
 * one SQLite file with no contention and ruled blue/green everywhere,
 * demos included." Every kind gets a colour pair (`ports.a`, `ports.b`) so
 * a reconciler can start the new colour, verify it and only then retire the
 * old one — this module renders both services from one descriptor rather
 * than one service per render call, so a single `render()` output is a
 * complete, swappable stack.
 *
 * `ports.health` is not a Compose port at all: the drain-flag health
 * sidecar (workspace#1187, already shipped) is a separate process the edge
 * probes directly, not a service this file defines.
 *
 * See the module's own note in `render.ts` on why this makes render's
 * output for a "tenant zero"-equivalent descriptor structurally different
 * from what `infra/tenant/compose.ts` renders today (one service, one
 * port) — that Done-criterion conflict is called out there rather than
 * silently resolved here.
 */

import { validatePrivateIpV4 } from './brand.js';
import type { ResourceCaps, TenantDescriptor } from './descriptor.js';
import type { UploadLimits } from './runtime.js';
import { adaptersVolumeName, contentVolumeName, stackName } from './naming.js';
import type { YamlValue } from './yaml.js';
import { toYaml } from './yaml.js';

/** Ghost's own listening port inside the container. */
export const GHOST_CONTAINER_PORT = 2368;

/** See `infra/tenant/compose.ts`'s own comment: a healthcheck probe of `/`
 * must carry this header or Ghost answers with a redirect `wget` cannot
 * follow, forever. */
const HEALTHCHECK_FORWARDED_PROTO = 'X-Forwarded-Proto: https';

const CONTENT_MOUNT_PATH = '/var/lib/ghost/content';
const ADAPTERS_MOUNT_PATH = `${CONTENT_MOUNT_PATH}/adapters`;

export interface ComposeStackArgs {
  readonly slug: TenantDescriptor['slug'];
  readonly uid: TenantDescriptor['uid'];
  readonly appHostPrivateIp: TenantDescriptor['appHostIp'];
  readonly ports: TenantDescriptor['ports'];
  readonly environment: Record<string, string | number | boolean>;
  readonly limits: UploadLimits;
  readonly caps: ResourceCaps;
}

type Colour = 'a' | 'b';

function ghostService(
  args: ComposeStackArgs,
  colour: Colour,
  content: string,
  adapters: string
): Record<string, YamlValue> {
  const hostPort = colour === 'a' ? args.ports.a : args.ports.b;
  return {
    image: '${IMAGE}',
    restart: 'unless-stopped',
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
    ports: [`${args.appHostPrivateIp}:${hostPort}:${GHOST_CONTAINER_PORT}`],
    environment: args.environment as YamlValue,
    volumes: [`${content}:${CONTENT_MOUNT_PATH}`, `${adapters}:${ADAPTERS_MOUNT_PATH}:ro`],
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

function composeDocument(args: ComposeStackArgs): Record<string, YamlValue> {
  const content = contentVolumeName(args.slug);
  const adapters = adaptersVolumeName(args.slug);

  return {
    name: stackName(args.slug),
    services: {
      'ghost-a': ghostService(args, 'a', content, adapters),
      'ghost-b': ghostService(args, 'b', content, adapters),
    },
    // `external: true`: the host-side provisioning step creates and owns
    // these volumes before this stack ever starts — see
    // `infra/tenant/compose.ts`'s own comment on why Compose must never be
    // the thing that first populates one.
    volumes: {
      [content]: { external: true },
      [adapters]: { external: true },
    },
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
  assertRuntimePosture(document, args.appHostPrivateIp);
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
  appHostPrivateIp: string
): void {
  // Validated here rather than taken on trust: every port check below
  // compares the rendered ports against this value, and an unchecked
  // `appHostPrivateIp` of `0.0.0.0` would produce `0.0.0.0:<port>:2368`,
  // which passes a naive comparison against itself. `validatePrivateIpV4`
  // throwing here is the refusal — a check whose expectation comes from
  // its own subject can never fail.
  validatePrivateIpV4(appHostPrivateIp);

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

    const logging = service.logging as Record<string, YamlValue> | undefined;
    const loggingOptions = logging?.options as Record<string, YamlValue> | undefined;
    if (!loggingOptions?.['max-size'] || !loggingOptions?.['max-file']) {
      at('must bound its json-file logs with `max-size` and `max-file`');
    }

    const ports = Array.isArray(service.ports) ? service.ports : [];
    for (const port of ports) {
      const parts = typeof port === 'string' ? port.split(':') : [];
      if (parts.length !== 3 || parts[0] !== appHostPrivateIp) {
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
    if (probe.kind === 'ok' && !probe.sendsHeader) {
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

  if (problems.length > 0) {
    throw new Error(
      `render(): rendered stack violates the runtime posture:\n- ${problems.join('\n- ')}`
    );
  }
}
