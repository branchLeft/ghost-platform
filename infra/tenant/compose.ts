/**
 * The Compose stack one tenant runs on a shared app host.
 *
 * One Compose project per tenant, named for the tenant slug, which is what
 * `branchleft-compose@%i` and `branchleft-deploy` already take as their
 * instance name. Three properties follow from that and are the reason it is
 * one project per tenant rather than one project with N services: Docker's
 * `DOCKER-ISOLATION-STAGE-1/2` chains drop traffic between different
 * user-defined bridges, so co-tenant containers cannot reach each other over
 * the network at all; each tenant's secrets stay in its own root-owned env
 * file rather than in one file every tenant's containers read; and restart,
 * rollback and failure are per tenant.
 *
 * Nothing here is optional. The runtime posture is rendered, not documented,
 * and `assertRuntimePosture` re-reads the finished document so a future edit
 * to this file that drops a control fails at construction rather than at an
 * incident.
 */

import { adaptersVolumeName, contentVolumeName, stackName, validateTenantSlug } from './naming';
import {
  validateAppHostPrivateIp,
  validateHostPort,
  validateTenantUid,
  type ResourceCaps,
  type UploadLimits,
} from './runtime';
import type { YamlValue } from './yaml';
import { toYaml } from './yaml';

/** Ghost's own listening port inside the container. The image's entrypoint
 * wrapper maps `$PORT` onto `server__port` and defaults to this. */
export const GHOST_CONTAINER_PORT = 2368;

/**
 * Ghost redirects any request it does not consider secure to
 * `https://<requested host>` whenever the configured `url` is HTTPS, so an
 * unadorned probe of `/` is answered with a 301 to `https://127.0.0.1:2368` —
 * TLS against a plaintext port — which `wget` follows and fails on, every
 * interval, forever. Express derives `req.secure` from this header for a
 * loopback client, and the edge proxy sets it on every real request, so a
 * probe carrying it exercises the path production traffic takes rather than
 * one chosen for being redirect-free.
 */
const HEALTHCHECK_FORWARDED_PROTO = 'X-Forwarded-Proto: https';

const CONTENT_MOUNT_PATH = '/var/lib/ghost/content';
/** Ghost's adapter manager `require()`s JavaScript out of this directory, and
 * it sits inside the volume a theme upload can write to. Left writable, an
 * arbitrary-file-write bug in the admin surface becomes arbitrary Node
 * execution at the next restart. The platform ships no custom adapter —
 * `S3Storage` is built into every official Ghost 6.x image and activated by
 * configuration alone — so an empty read-only mount over this one path costs
 * nothing. If the platform ever does need a custom adapter it arrives in the
 * image, not in a tenant volume. */
const ADAPTERS_MOUNT_PATH = `${CONTENT_MOUNT_PATH}/adapters`;

export interface ComposeStackArgs {
  slug: string;
  /** Reserved per-tenant UID; the content volume is owned by it at `0700`. */
  uid: number;
  /** The app host's private address. Publishing is to this and nothing
   * else — never `0.0.0.0`, which would put a tenant on the host's public
   * interface behind only a Hetzner firewall rule. */
  appHostPrivateIp: string;
  /** Host-side port for this tenant. Distinct per tenant on a shared host. */
  hostPort: number;
  environment: Record<string, string | number | boolean>;
  limits: UploadLimits;
  caps: ResourceCaps;
}

export function renderComposeStack(args: ComposeStackArgs): string {
  // Re-validated here rather than only in the component, so the renderer is
  // safe to call directly — a tenant repo that renders its own stack file
  // gets the same refusals as one that goes through `GhostTenant`.
  validateTenantSlug(args.slug);
  validateTenantUid(args.uid);
  validateAppHostPrivateIp(args.appHostPrivateIp);
  validateHostPort(args.hostPort);
  const document = composeDocument(args);
  assertRuntimePosture(document, args);
  return `${header(args.slug)}\n${toYaml(document)}`;
}

function header(slug: string): string {
  return [
    `# The ${slug} Ghost stack, deployed as \`${stackName(slug)}\` under`,
    `# /opt/branchleft/${stackName(slug)} on an app host.`,
    '#',
    '# Rendered by @branchleft/ghost-platform-tenant. Do not hand-edit on the',
    '# host: every line below is a runtime-isolation control, and a stack that',
    '# omits one still starts, still serves, and silently drops the boundary.',
    '#',
    '# `${IMAGE}` is written to /etc/branchleft/<stack>.image.env by',
    '# /usr/local/sbin/branchleft-deploy and is always a digest, never a tag.',
    '# The `${GHOST_*}` references come from /etc/branchleft/<stack>.env, which',
    '# is root-owned 0600 and written by an operator alone.',
  ].join('\n');
}

function composeDocument(args: ComposeStackArgs): Record<string, YamlValue> {
  const content = contentVolumeName(args.slug);
  const adapters = adaptersVolumeName(args.slug);

  return {
    name: stackName(args.slug),
    services: {
      ghost: {
        image: '${IMAGE}',
        restart: 'unless-stopped',
        // Distinct per tenant and never reused. This is the single control
        // that separates one tenant's data from another's on a shared host,
        // and it is the one the base image works against: the official image
        // ends with `chmod 1777` on the content directory, world-writable,
        // because it is designed for one site per host.
        user: `${args.uid}:${args.uid}`,
        init: true,
        read_only: true,
        // `/tmp` is more than upload staging: theme ZIP extraction, theme
        // re-zipping for download, the content import manager's scratch
        // directory and the members import spool all land here. It is a
        // tmpfs because the rootfs is read-only, and tmpfs pages are charged
        // to this container's memory cgroup — which is why `mem_limit` below
        // is the RSS budget plus this size, not the RSS budget alone.
        tmpfs: [`/tmp:rw,noexec,nosuid,nodev,size=${args.limits.tmpfsSize}`],
        // Ghost listens above 1024, so `NET_BIND_SERVICE` is not needed, and
        // nothing else in the image wants a capability once `user:` has
        // removed the root phase from the boot path.
        cap_drop: ['ALL'],
        // Blocks the setuid/file-capability route to privilege gain, the
        // standard second half of an escape chain. Free here, because `user:`
        // already removed the one legitimate privilege transition (`gosu`).
        security_opt: ['no-new-privileges:true'],
        pids_limit: args.caps.pidsLimit,
        mem_limit: args.limits.memoryLimit,
        // `mem_limit` alone is not a bound while this is unset — the
        // container may then use swap without limit.
        memswap_limit: args.limits.memoryLimit,
        // `cpu_shares` is a relative weight with no ceiling, so on a
        // deliberately oversubscribed host one tenant's runaway loop takes
        // whatever is idle until an alert fires. Both are set.
        cpus: args.caps.cpus,
        cpu_shares: args.caps.cpuShares,
        ulimits: {
          nofile: { soft: args.caps.nofile, hard: args.caps.nofile },
        },
        // The one people forget and the one that takes the host down:
        // Docker's json-file driver is unbounded by default, so a single
        // tenant logging at volume fills the host's disk and stops every
        // co-tenant, the database dumps and the deploy path with it.
        logging: {
          driver: 'json-file',
          options: { 'max-size': '10m', 'max-file': '3' },
        },
        ports: [`${args.appHostPrivateIp}:${args.hostPort}:${GHOST_CONTAINER_PORT}`],
        environment: args.environment as YamlValue,
        volumes: [`${content}:${CONTENT_MOUNT_PATH}`, `${adapters}:${ADAPTERS_MOUNT_PATH}:ro`],
        // Two argv elements rather than `--header=<value>`: the image is
        // Alpine-based, so this is BusyBox `wget`, and the separated form is
        // the one both it and GNU `wget` accept.
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
      },
    },
    // `external: true` is the load-bearing half. Docker applies the image
    // path's ownership and mode to a *fresh* named volume when it first
    // populates one, so a volume Compose creates here would be re-owned to
    // the image's `node`/`1777` over whatever provisioning had set — the
    // failure that leaves every container starting normally on a
    // world-writable volume. Declaring the volumes external instead makes the
    // host-side provisioning step a precondition: a missing volume fails the
    // stack's start loudly, which is the opposite of that failure mode.
    volumes: {
      [content]: { external: true },
      [adapters]: { external: true },
    },
  };
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

/**
 * Re-reads the finished document and refuses anything outside the posture.
 *
 * A posture with no test for its absence is a comment. This runs inside
 * `renderComposeStack`, so the refusal is at construction time in the
 * tenant's own Pulumi program — there is no rendered stack that reaches an
 * app host without having passed it.
 */
export function assertRuntimePosture(
  document: Record<string, YamlValue>,
  args: Pick<ComposeStackArgs, 'appHostPrivateIp'>
): void {
  // Validated here rather than taken on trust, because everything below
  // compares the rendered ports against this value: an unchecked
  // `appHostPrivateIp` of `0.0.0.0` produces `0.0.0.0:8081:2368`, which passes
  // a `startsWith` against itself. A check whose expectation comes from its
  // subject cannot fail.
  validateAppHostPrivateIp(args.appHostPrivateIp);

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
      // `<address>:<host port>:<container port>` and nothing shorter. A
      // two-part publish is `<host port>:<container port>`, which binds every
      // interface -- the same outcome as `0.0.0.0` and harder to spot.
      const parts = typeof port === 'string' ? port.split(':') : [];
      if (parts.length !== 3 || parts[0] !== args.appHostPrivateIp) {
        at(
          `publishes \`${String(port)}\` — every port must be ` +
            `<app-host-private-ip>:<host-port>:<container-port>`
        );
        continue;
      }
      const hostPort = Number(parts[1]);
      if (!/^\d+$/.test(parts[1]) || !Number.isInteger(hostPort)) {
        at(`publishes \`${String(port)}\` — the host port is not a number`);
        continue;
      }
      try {
        validateHostPort(hostPort);
      } catch (error) {
        at((error as Error).message);
      }
    }

    // A probe that can never pass is worse than no probe at all: the unit's
    // `docker compose up --wait` fails on it, so every deploy of a perfectly
    // healthy tenant reports failure and the signal stops carrying anything.
    // Asserting the header here is what makes that a construction-time
    // refusal rather than something found on a host.
    const healthcheck = service.healthcheck as Record<string, YamlValue> | undefined;
    const probe = Array.isArray(healthcheck?.test) ? healthcheck.test : [];
    if (probe.length === 0) {
      at('must declare a `healthcheck.test`');
    } else if (!probe.includes(HEALTHCHECK_FORWARDED_PROTO)) {
      at(
        `must send \`${HEALTHCHECK_FORWARDED_PROTO}\` in its healthcheck, or Ghost ` +
          `answers the probe with a 301 to HTTPS that it cannot follow`
      );
    }

    const volumes = Array.isArray(service.volumes) ? service.volumes : [];
    for (const volume of volumes) {
      if (typeof volume !== 'string' || volume.startsWith('/') || volume.startsWith('.')) {
        at(`mounts \`${String(volume)}\` — only named volumes, never a host path`);
      } else if (volume.includes('docker.sock')) {
        // Called out separately because it is not a partial grant: a
        // container holding the socket can create a second container that
        // mounts `/` and is therefore host root.
        at('must never receive the Docker socket');
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `GhostTenant: rendered stack violates the runtime posture:\n- ${problems.join('\n- ')}`
    );
  }
}
