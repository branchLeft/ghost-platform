/**
 * The one mail spool a host runs (LLD-6 §03): a Compose stack of its own,
 * beside every Ghost stack on that host, rendered from the uids of the
 * tenants or demo slots it serves. Ghost reaches it by name on a per-tenant
 * internal network; ops1's collector reaches its drain endpoint only through
 * a port published on the host's loopback. See spool.md.
 */

import {
  FieldValidationError,
  validateDigestPinnedRef,
  validatePort,
  validateTenantUid,
  type DigestPinnedRef,
  type Port,
  type TenantUid,
} from './brand.js';
import type { YamlValue } from './yaml.js';
import { toYaml } from './yaml.js';

/** The spool's Compose project name, its directory under /opt/branchleft and
 * its `branchleft-compose@` instance. Reserved against tenant slugs. */
export const MAIL_SPOOL_STACK = 'mail-spool';

/** The service name, which Compose also makes its DNS name on every network
 * it joins: the one name every Ghost on the host is pointed at. */
export const MAIL_SPOOL_SERVICE = 'mail-spool';

/** The spool's HTTP listener inside its container: the Mailgun-shaped API
 * Ghost's bulk sender calls, and the drain endpoint ops1 calls. */
export const MAIL_SPOOL_HTTP_PORT = 8080;

/** The spool's SMTP front door inside its container, for Ghost's
 * transactional sender. Never published. */
export const MAIL_SPOOL_SMTP_PORT = 2525;

/** Where Ghost's Mailgun client is pointed. Derived from the two constants
 * above, so Ghost's environment and the spool's own listener cannot name
 * different places. */
export const MAIL_SPOOL_BASE_URL = `http://${MAIL_SPOOL_SERVICE}:${MAIL_SPOOL_HTTP_PORT}`;

/** The only address the drain port is ever published on. See
 * spool.md#the-drain-port. */
export const MAIL_SPOOL_DRAIN_BIND_ADDRESS = '127.0.0.1';

/** Outside the reserved tenant range on purpose, so the spool can never run
 * as, or own the files of, any tenant or slot. */
export const MAIL_SPOOL_UID = 31000;

/** Host-provisioned before the stack starts, owned by `MAIL_SPOOL_UID`, and
 * named for no slot, so no slot's reset or wipe can reach it. */
export const MAIL_SPOOL_DATA_VOLUME = 'branchleft-mail-spool-data';

const DATA_MOUNT_PATH = '/data';
const DB_PATH = `${DATA_MOUNT_PATH}/spool.sqlite`;

/** The one network that carries the published drain port. See
 * spool.md#the-drain-network. */
export const MAIL_SPOOL_DRAIN_NETWORK = 'branchleft-mail-spool-drain';

/** The drain network's bridge interface name on the host: inside demo1's
 * `br-+` egress policy, and a fixed name an app host's policy can match. */
export const MAIL_SPOOL_DRAIN_BRIDGE = 'br-mailspool';

/** Where the spool's one secret is read from; root-owned, 0600, written by
 * an operator alone. */
export const MAIL_SPOOL_SECRETS_PATH = `/etc/branchleft/${MAIL_SPOOL_STACK}.env`;

/** The one secret the spool's Compose file references, never carries. */
export const MAIL_SPOOL_DRAIN_TOKEN_KEY = 'SHIM_DRAIN_TOKEN';

/**
 * The internal network one tenant (or one demo slot) shares with the spool
 * and with nothing else. Keyed on the uid, the stable per-slot identity,
 * never on a demo's throwaway slug. See spool.md#one-network-per-tenant.
 */
export function mailSpoolNetworkName(uid: TenantUid): string {
  return `branchleft-mail-${uid}`;
}

export interface MailSpoolStackArgs {
  /** The spool image, pinned by digest in the rendered file itself. */
  readonly image: DigestPinnedRef;
  /** The uid of every tenant or demo slot on this host with mail enabled. */
  readonly uids: readonly TenantUid[];
  /** The host-loopback port ops1's tunnel lands on. */
  readonly drainPort: Port;
}

const SPOOL_LIMITS = {
  pidsLimit: 128,
  memory: '256m',
  cpus: '0.5',
  tmpfs: '16m',
} as const;

function healthcheck(): Record<string, YamlValue> {
  return {
    test: [
      'CMD',
      'node',
      '-e',
      `fetch('http://127.0.0.1:${MAIL_SPOOL_HTTP_PORT}/healthz')` +
        '.then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))',
    ],
    interval: '30s',
    timeout: '5s',
    retries: 3,
    start_period: '20s',
  };
}

/** The spool stack as a document, before the posture check and the header. */
export function mailSpoolDocument(args: MailSpoolStackArgs): Record<string, YamlValue> {
  const tenantNetworks = [...new Set(args.uids)].sort((a, b) => a - b).map(mailSpoolNetworkName);

  const networks: Record<string, YamlValue> = {
    [MAIL_SPOOL_DRAIN_NETWORK]: {
      name: MAIL_SPOOL_DRAIN_NETWORK,
      driver: 'bridge',
      driver_opts: {
        'com.docker.network.bridge.name': MAIL_SPOOL_DRAIN_BRIDGE,
        'com.docker.network.bridge.enable_ip_masquerade': 'false',
      },
    },
  };
  for (const name of tenantNetworks) {
    networks[name] = { name, internal: true };
  }

  return {
    name: MAIL_SPOOL_STACK,
    services: {
      [MAIL_SPOOL_SERVICE]: {
        image: args.image,
        restart: 'unless-stopped',
        user: `${MAIL_SPOOL_UID}:${MAIL_SPOOL_UID}`,
        init: true,
        read_only: true,
        tmpfs: [`/tmp:rw,noexec,nosuid,nodev,size=${SPOOL_LIMITS.tmpfs}`],
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        pids_limit: SPOOL_LIMITS.pidsLimit,
        mem_limit: SPOOL_LIMITS.memory,
        memswap_limit: SPOOL_LIMITS.memory,
        cpus: SPOOL_LIMITS.cpus,
        logging: {
          driver: 'json-file',
          options: { 'max-size': '10m', 'max-file': '3' },
        },
        environment: {
          PORT: MAIL_SPOOL_HTTP_PORT,
          SMTP_LISTEN_PORT: MAIL_SPOOL_SMTP_PORT,
          SHIM_DB_PATH: DB_PATH,
          [MAIL_SPOOL_DRAIN_TOKEN_KEY]:
            `\${${MAIL_SPOOL_DRAIN_TOKEN_KEY}:?set ${MAIL_SPOOL_DRAIN_TOKEN_KEY} in ` +
            `${MAIL_SPOOL_SECRETS_PATH}}`,
        },
        ports: [`${MAIL_SPOOL_DRAIN_BIND_ADDRESS}:${args.drainPort}:${MAIL_SPOOL_HTTP_PORT}`],
        networks: [MAIL_SPOOL_DRAIN_NETWORK, ...tenantNetworks],
        volumes: [`${MAIL_SPOOL_DATA_VOLUME}:${DATA_MOUNT_PATH}`],
        healthcheck: healthcheck(),
      },
    },
    networks,
    volumes: {
      [MAIL_SPOOL_DATA_VOLUME]: { external: true },
    },
  };
}

function header(): string {
  return [
    `# The host's one mail spool, deployed as \`${MAIL_SPOOL_STACK}\` under`,
    `# /opt/branchleft/${MAIL_SPOOL_STACK}.`,
    '#',
    '# Rendered by @branchleft/ghost-platform-render-core. Do not hand-edit on',
    '# the host: the networks and the one published port below are what keep',
    '# queued mail on this host, and a file that drops one still starts.',
    '#',
    `# \`\${${MAIL_SPOOL_DRAIN_TOKEN_KEY}}\` comes from ${MAIL_SPOOL_SECRETS_PATH},`,
    '# root-owned 0600 and written by an operator alone.',
  ].join('\n');
}

/**
 * Renders the spool's Compose file, then re-reads it against the spool's
 * posture before returning it, so no rendered spool reaches a caller
 * without having passed `assertSpoolPosture`.
 */
export function renderMailSpoolStack(args: MailSpoolStackArgs): string {
  validateDigestPinnedRef(args.image);
  validatePort(args.drainPort, 'drainPort');
  if (args.uids.length === 0) {
    throw new FieldValidationError(
      'uids',
      'a mail spool with no tenant to serve has nothing to queue; render none instead.'
    );
  }
  for (const uid of args.uids) {
    validateTenantUid(uid);
  }
  const document = mailSpoolDocument(args);
  assertSpoolPosture(document, args.drainPort);
  return `${header()}\n${toYaml(document)}`;
}

const FORBIDDEN_SPOOL_KEYS = [
  'privileged',
  'cap_add',
  'devices',
  'network_mode',
  'pid',
  'ipc',
  'userns_mode',
  'cgroup_parent',
  'external_links',
  'extra_hosts',
  'dns',
] as const;

const SECRET_REFERENCE = /^\$\{[A-Z0-9_]+:\?[^}]*\}$/;

function asRecord(value: YamlValue | undefined): Record<string, YamlValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, YamlValue>)
    : undefined;
}

function serviceNetworkNames(service: Record<string, YamlValue>): string[] | null {
  const networks = service.networks;
  if (Array.isArray(networks)) {
    return networks.filter((n): n is string => typeof n === 'string');
  }
  const record = asRecord(networks);
  return record ? Object.keys(record) : null;
}

function checkNetworks(
  service: Record<string, YamlValue>,
  topLevel: Record<string, YamlValue>,
  at: (message: string) => void
): void {
  const names = serviceNetworkNames(service);
  if (names === null || names.length === 0) {
    at(
      'must list its networks explicitly; with none it joins the default network, which has egress'
    );
    return;
  }
  for (const name of names) {
    const network = asRecord(topLevel[name]);
    if (!network) {
      at(`joins network "${name}", which the file does not declare`);
      continue;
    }
    if (name === MAIL_SPOOL_DRAIN_NETWORK) {
      const opts = asRecord(network.driver_opts) ?? {};
      if (opts['com.docker.network.bridge.name'] !== MAIL_SPOOL_DRAIN_BRIDGE) {
        at(
          `network "${name}" must use the bridge name "${MAIL_SPOOL_DRAIN_BRIDGE}", the name ` +
            `the host's egress policy matches`
        );
      }
      if (opts['com.docker.network.bridge.enable_ip_masquerade'] !== 'false') {
        at(
          `network "${name}" must disable IP masquerade, or the spool's packets can leave the host`
        );
      }
      if (network.internal === true || network.external === true) {
        at(`network "${name}" must be a plain bridge this file owns`);
      }
      continue;
    }
    if (network.external === true) {
      at(
        `network "${name}" must be owned by this file, or \`internal\` is not what Docker applies`
      );
    }
    if (network.internal !== true) {
      at(
        `joins network "${name}", which is not \`internal: true\` -- only the drain network may ` +
          `have a gateway, and every other network must give the spool no route off the host`
      );
    }
  }
}

function checkPorts(
  service: Record<string, YamlValue>,
  drainPort: number,
  at: (message: string) => void
): void {
  const ports = Array.isArray(service.ports) ? service.ports : [];
  const expected = `${MAIL_SPOOL_DRAIN_BIND_ADDRESS}:${drainPort}:${MAIL_SPOOL_HTTP_PORT}`;
  if (ports.length !== 1 || ports[0] !== expected) {
    at(
      `publishes ${JSON.stringify(ports)} -- the spool publishes exactly one port, ` +
        `"${expected}": the drain port, on host loopback only`
    );
  }
  if (service.expose !== undefined) {
    at('must not set `expose`');
  }
}

function checkEnvironment(service: Record<string, YamlValue>, at: (message: string) => void): void {
  const environment = asRecord(service.environment);
  if (!environment) {
    at('must declare an `environment` map');
    return;
  }
  const token = environment[MAIL_SPOOL_DRAIN_TOKEN_KEY];
  if (typeof token !== 'string' || !SECRET_REFERENCE.test(token)) {
    at(`must carry ${MAIL_SPOOL_DRAIN_TOKEN_KEY} as a \`\${VAR:?...}\` reference, never a value`);
  }
  if (environment.SHIM_ALLOW_EPHEMERAL_DB !== undefined) {
    at('must not allow an ephemeral queue: a restart would drop every queued message');
  }
  if (environment.SMTP_LISTEN_HOST !== undefined) {
    at('must not override the SMTP listen address; reach is decided by the networks, not the bind');
  }
}

/**
 * Re-reads a rendered spool document and refuses anything that would give
 * the spool a route off the host, publish anything but the loopback drain
 * port, carry a secret, or drop the runtime hardening. See
 * spool.md#the-posture-check.
 */
export function assertSpoolPosture(document: Record<string, YamlValue>, drainPort: number): void {
  const services = asRecord(document.services) ?? {};
  const topLevelNetworks = asRecord(document.networks) ?? {};
  const problems: string[] = [];

  const names = Object.keys(services);
  if (names.length !== 1 || names[0] !== MAIL_SPOOL_SERVICE) {
    problems.push(`the stack must declare exactly one service, "${MAIL_SPOOL_SERVICE}"`);
  }

  for (const [name, raw] of Object.entries(services)) {
    const service = asRecord(raw) ?? {};
    const at = (message: string) => problems.push(`service "${name}": ${message}`);

    for (const key of FORBIDDEN_SPOOL_KEYS) {
      if (key in service) at(`must not set \`${key}\``);
    }
    if (typeof service.image !== 'string') {
      at('must name its image');
    } else {
      try {
        validateDigestPinnedRef(service.image);
      } catch {
        at(`image "${service.image}" must be pinned by digest`);
      }
    }
    if (service.read_only !== true) at('must set `read_only: true`');
    if (service.init !== true) at('must set `init: true`');
    if (service.user !== `${MAIL_SPOOL_UID}:${MAIL_SPOOL_UID}`) {
      at(`must run as \`${MAIL_SPOOL_UID}:${MAIL_SPOOL_UID}\``);
    }
    if (!Array.isArray(service.cap_drop) || !service.cap_drop.includes('ALL')) {
      at('must set `cap_drop: [ALL]`');
    }
    const securityOpt = Array.isArray(service.security_opt) ? service.security_opt : [];
    if (!securityOpt.includes('no-new-privileges:true')) {
      at('must set `security_opt: [no-new-privileges:true]`');
    }
    if (typeof service.pids_limit !== 'number') at('must set `pids_limit`');
    if (typeof service.mem_limit !== 'string' || service.memswap_limit !== service.mem_limit) {
      at('must set `mem_limit` and an equal `memswap_limit`');
    }

    const volumes = Array.isArray(service.volumes) ? service.volumes : [];
    if (volumes.length !== 1 || volumes[0] !== `${MAIL_SPOOL_DATA_VOLUME}:${DATA_MOUNT_PATH}`) {
      at(
        `mounts ${JSON.stringify(volumes)} -- the spool mounts only its own data volume, ` +
          `"${MAIL_SPOOL_DATA_VOLUME}", never a host path or a tenant's volume`
      );
    }

    checkNetworks(service, topLevelNetworks, at);
    checkPorts(service, drainPort, at);
    checkEnvironment(service, at);
  }

  if (problems.length > 0) {
    throw new Error(
      `renderMailSpoolStack(): rendered spool violates its posture:\n- ${problems.join('\n- ')}`
    );
  }
}
