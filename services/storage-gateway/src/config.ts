import { isAbsolute } from 'node:path';
import { MAX_UPLOAD_CEILING_MIB } from './credentials/admin.js';

const MIB = 1024 * 1024;

/**
 * Raised for a setting that is missing or wrong. The message names the
 * variable and never its value, so it is safe to log.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Every variable the service reads. Secrets are named by file, never by value. */
export const ENV = {
  region: 'STORAGE_GATEWAY_REGION',
  listenHost: 'STORAGE_GATEWAY_LISTEN_HOST',
  listenPort: 'STORAGE_GATEWAY_LISTEN_PORT',
  tlsCertFile: 'STORAGE_GATEWAY_TLS_CERT_FILE',
  tlsKeyFile: 'STORAGE_GATEWAY_TLS_KEY_FILE',
  plaintextBehindProxy: 'STORAGE_GATEWAY_PLAINTEXT_BEHIND_TLS_PROXY',
  upstreamEndpoint: 'STORAGE_GATEWAY_UPSTREAM_ENDPOINT',
  upstreamRegion: 'STORAGE_GATEWAY_UPSTREAM_REGION',
  upstreamKeyIdFile: 'STORAGE_GATEWAY_UPSTREAM_KEY_ID_FILE',
  upstreamSecretFile: 'STORAGE_GATEWAY_UPSTREAM_SECRET_FILE',
  upstreamDeadlineMs: 'STORAGE_GATEWAY_UPSTREAM_DEADLINE_MS',
  storePath: 'STORAGE_GATEWAY_STORE_PATH',
  storeAnchorPath: 'STORAGE_GATEWAY_STORE_ANCHOR_PATH',
  spoolDir: 'STORAGE_GATEWAY_SPOOL_DIR',
  spoolThresholdBytes: 'STORAGE_GATEWAY_SPOOL_THRESHOLD_BYTES',
  maxBodyMib: 'STORAGE_GATEWAY_MAX_BODY_MIB',
  requestTimeoutMs: 'STORAGE_GATEWAY_REQUEST_TIMEOUT_MS',
  shutdownGraceMs: 'STORAGE_GATEWAY_SHUTDOWN_GRACE_MS',
  adminKeysFile: 'STORAGE_GATEWAY_ADMIN_KEYS_FILE',
  adminListenHost: 'STORAGE_GATEWAY_ADMIN_LISTEN_HOST',
  adminListenPort: 'STORAGE_GATEWAY_ADMIN_LISTEN_PORT',
  adminReplayWindowSeconds: 'STORAGE_GATEWAY_ADMIN_REPLAY_WINDOW_SECONDS',
} as const;

/**
 * The most body bytes the gateway reads from a client it has not yet
 * authenticated: the largest ceiling any tenant may hold. A tenant's own
 * ceiling is applied once its signature has verified.
 */
export const PREAUTH_BODY_CAP_MIB = MAX_UPLOAD_CEILING_MIB;

export interface ListenConfig {
  readonly host: string;
  readonly port: number;
}

export interface TlsConfig {
  readonly certFile: string;
  readonly keyFile: string;
}

export interface AdminConfig extends ListenConfig {
  /** A root-owned keys file whose digest is pinned beside it. */
  readonly keysFile: string;
  readonly replayWindowSeconds: number;
}

export interface GatewayConfig {
  /** The region every tenant's credential scope must name. */
  readonly region: string;
  readonly listen: ListenConfig;
  readonly tls?: TlsConfig;
  readonly upstream: {
    readonly endpoint: string;
    readonly region: string;
    readonly keyIdFile: string;
    readonly secretFile: string;
    readonly deadlineMs: number;
  };
  readonly storePath: string;
  readonly storeAnchorPath: string;
  readonly spoolDir: string;
  readonly spoolThresholdBytes?: number;
  /** The pre-authentication body cap, in bytes. */
  readonly maxBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly shutdownGraceMs: number;
  /** Absent: the admin interface is not served at all. */
  readonly admin?: AdminConfig;
}

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);
const TRUE = 'true';

function text(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function required(env: Env, name: string): string {
  const value = text(env, name);
  if (value === undefined) throw new ConfigError(`${name} is not set; refusing to start`);
  return value;
}

function absolutePath(env: Env, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value)) throw new ConfigError(`${name} must be an absolute path`);
  return value;
}

function whole(
  env: Env,
  name: string,
  options: { fallback: number; min: number; max: number }
): number {
  const raw = text(env, name);
  if (raw === undefined) return options.fallback;
  const value = Number(raw);
  if (!/^[0-9]{1,15}$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new ConfigError(`${name} must be a whole number`);
  }
  if (value < options.min || value > options.max) {
    throw new ConfigError(`${name} must be between ${options.min} and ${options.max}`);
  }
  return value;
}

/** A listener may leave the host's loopback only over TLS, or behind a proxy that does the TLS. */
function checkTransport(
  name: string,
  host: string,
  tls: TlsConfig | undefined,
  behindProxy: boolean
): void {
  if (tls === undefined && !LOOPBACK.has(host) && !behindProxy) {
    throw new ConfigError(
      `${name} is not loopback and no TLS is configured; set ${ENV.tlsCertFile} and ${ENV.tlsKeyFile}, ` +
        `or ${ENV.plaintextBehindProxy}=${TRUE} when a TLS proxy fronts this listener`
    );
  }
}

/** Reads and checks the settings. Opens no file: secrets are read where they are used. */
export function loadConfig(env: Env): GatewayConfig {
  const certFile = text(env, ENV.tlsCertFile);
  const keyFile = text(env, ENV.tlsKeyFile);
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new ConfigError(`${ENV.tlsCertFile} and ${ENV.tlsKeyFile} must be set together`);
  }
  const tls: TlsConfig | undefined =
    certFile === undefined || keyFile === undefined
      ? undefined
      : {
          certFile: absolutePath(env, ENV.tlsCertFile),
          keyFile: absolutePath(env, ENV.tlsKeyFile),
        };

  const proxyFlag = text(env, ENV.plaintextBehindProxy);
  if (proxyFlag !== undefined && proxyFlag !== TRUE && proxyFlag !== 'false') {
    throw new ConfigError(`${ENV.plaintextBehindProxy} must be ${TRUE} or false`);
  }
  const behindProxy = proxyFlag === TRUE;

  const region = required(env, ENV.region);
  const listen: ListenConfig = {
    host: text(env, ENV.listenHost) ?? '127.0.0.1',
    port: whole(env, ENV.listenPort, { fallback: 8443, min: 0, max: 65535 }),
  };
  checkTransport(ENV.listenHost, listen.host, tls, behindProxy);

  const maxBodyMib = whole(env, ENV.maxBodyMib, {
    fallback: PREAUTH_BODY_CAP_MIB,
    min: 1,
    max: PREAUTH_BODY_CAP_MIB,
  });
  const thresholdRaw = text(env, ENV.spoolThresholdBytes);

  const keysFile = text(env, ENV.adminKeysFile);
  let admin: AdminConfig | undefined;
  if (keysFile !== undefined) {
    admin = {
      keysFile: absolutePath(env, ENV.adminKeysFile),
      host: text(env, ENV.adminListenHost) ?? '127.0.0.1',
      port: whole(env, ENV.adminListenPort, { fallback: 8444, min: 0, max: 65535 }),
      replayWindowSeconds: whole(env, ENV.adminReplayWindowSeconds, {
        fallback: 60,
        min: 1,
        max: 600,
      }),
    };
    checkTransport(ENV.adminListenHost, admin.host, tls, behindProxy);
  }

  return {
    region,
    listen,
    ...(tls === undefined ? {} : { tls }),
    upstream: {
      endpoint: required(env, ENV.upstreamEndpoint),
      region: text(env, ENV.upstreamRegion) ?? region,
      keyIdFile: absolutePath(env, ENV.upstreamKeyIdFile),
      secretFile: absolutePath(env, ENV.upstreamSecretFile),
      deadlineMs: whole(env, ENV.upstreamDeadlineMs, {
        fallback: 120_000,
        min: 1000,
        max: 3_600_000,
      }),
    },
    storePath: absolutePath(env, ENV.storePath),
    storeAnchorPath: absolutePath(env, ENV.storeAnchorPath),
    spoolDir: absolutePath(env, ENV.spoolDir),
    ...(thresholdRaw === undefined
      ? {}
      : {
          spoolThresholdBytes: whole(env, ENV.spoolThresholdBytes, {
            fallback: 0,
            min: 1,
            max: 1024 * MIB,
          }),
        }),
    maxBodyBytes: maxBodyMib * MIB,
    requestTimeoutMs: whole(env, ENV.requestTimeoutMs, {
      fallback: 300_000,
      min: 1000,
      max: 3_600_000,
    }),
    shutdownGraceMs: whole(env, ENV.shutdownGraceMs, {
      fallback: 30_000,
      min: 0,
      max: 600_000,
    }),
    ...(admin === undefined ? {} : { admin }),
  };
}
