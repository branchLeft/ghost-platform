import { constants, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdminHandler } from './admin-listener.js';
import { ConfigError, type GatewayConfig } from './config.js';
import { createAdminInterface } from './credentials/admin.js';
import { createInMemoryNonceStore, loadPinnedCallerKeys } from './credentials/adminAuth.js';
import { loadMasterSecret } from './credentials/masterSecret.js';
import { createSigningSecretSource } from './credentials/secretSource.js';
import { MIGRATIONS_FOLDER, SqliteCredentialStore } from './credentials/store.js';
import { sweepSpoolDir } from './body.js';
import { createManagedListener, type ManagedListener } from './listener.js';
import { createLog, type LogSink } from './logging.js';
import { readOwnerOnlyFile } from './secretFile.js';
import { createGatewayListener } from './server.js';
import { SigV4Verifier } from './sigv4-verifier.js';
import { createInMemoryUploadBindings } from './uploads.js';
import { UpstreamCredentials, createUpstream } from './upstream.js';

/** The largest key id or secret the storage service issues, with room to spare. */
const UPSTREAM_SECRET_FILE_MAX_BYTES = 512;
const TLS_KEY_FILE_MAX_BYTES = 16 * 1024;
/** A key id that no credential holds: the readiness check asks the store about it. */
const READINESS_PROBE_KEY_ID = 'readiness-probe';
/** The admin interface takes a handful of callers; it needs no more connections than this. */
const ADMIN_MAX_CONNECTIONS = 16;

function limitsOf(config: GatewayConfig): {
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
} {
  return {
    requestTimeoutMs: config.requestTimeoutMs,
    headersTimeoutMs: config.headersTimeoutMs,
    keepAliveTimeoutMs: config.keepAliveTimeoutMs,
  };
}

export interface StartOptions {
  /** The process environment: only the master secret's file setting is read from it here. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sink: LogSink;
  /** Test seam: the owner the pinned admin key files must have. Defaults to root. */
  readonly trustedUid?: number;
  /** Test seam: the admin interface's clock, in milliseconds. */
  readonly adminClock?: () => number;
}

export interface RunningGateway {
  /** The tenant-facing server, exposed so a test can read the limits it was started with. */
  readonly tenantServer: Server;
  readonly address: AddressInfo;
  readonly adminAddress?: AddressInfo;
  /** Drains both listeners within the configured grace, closes the store, and reports whether it had to cut connections. */
  stop(): Promise<{ readonly forced: boolean }>;
}

function secretText(path: string, label: string): string {
  const raw = readOwnerOnlyFile(path, {
    label,
    expectedUid: process.getuid?.() ?? -1,
    maxBytes: UPSTREAM_SECRET_FILE_MAX_BYTES,
    fail: (message) => new ConfigError(message),
  });
  const value = raw.toString('utf8').trim();
  raw.fill(0);
  if (value === '') throw new ConfigError(`${label} file is empty`);
  return value;
}

/** Builds the service from its configuration and starts listening. Opens nothing before the settings are checked. */
export async function startGateway(
  config: GatewayConfig,
  options: StartOptions
): Promise<RunningGateway> {
  const log = createLog(options.sink);
  const master = loadMasterSecret({ env: options.env });
  const upstreamCredentials = new UpstreamCredentials(
    secretText(config.upstream.keyIdFile, 'upstream key id'),
    secretText(config.upstream.secretFile, 'upstream secret')
  );
  const tls =
    config.tls === undefined
      ? undefined
      : {
          cert: readFileSync(config.tls.certFile),
          key: readOwnerOnlyFile(config.tls.keyFile, {
            label: 'TLS key',
            expectedUid: process.getuid?.() ?? -1,
            maxBytes: TLS_KEY_FILE_MAX_BYTES,
            fail: (message) => new ConfigError(message),
          }),
        };

  const swept = await sweepSpoolDir(config.spoolDir);
  if (swept > 0)
    log.service({
      event: 'service',
      message: 'removed leftover spool files',
      detail: String(swept),
    });

  const store = SqliteCredentialStore.open(
    config.storePath,
    MIGRATIONS_FOLDER,
    config.storeAnchorPath
  );
  const listeners: ManagedListener[] = [];
  try {
    const uploads = createInMemoryUploadBindings();
    const verifier = new SigV4Verifier({
      region: config.region,
      secrets: createSigningSecretSource(store, master),
    });
    const upstream = createUpstream({
      endpoint: config.upstream.endpoint,
      region: config.upstream.region,
      credentials: upstreamCredentials,
      deadlineMs: config.upstream.deadlineMs,
      uploads,
      logger: log,
    });
    const readiness = async (): Promise<string | undefined> => {
      try {
        store.get(READINESS_PROBE_KEY_ID);
      } catch {
        return 'store';
      }
      try {
        await access(config.spoolDir, constants.W_OK);
      } catch {
        return 'spool';
      }
      return undefined;
    };

    const gateway = createGatewayListener(
      {
        verifier,
        credentials: store,
        upstream,
        uploads,
        log,
        spoolDir: config.spoolDir,
        ...(config.spoolThresholdBytes === undefined
          ? {}
          : { spoolThresholdBytes: config.spoolThresholdBytes }),
        maxBodyBytes: config.maxBodyBytes,
        maxConcurrentUploads: config.maxConcurrentUploads,
        readiness,
      },
      {
        ...limitsOf(config),
        maxConnections: config.maxConnections,
        holdContinue: true,
        ...(tls === undefined ? {} : { tls }),
      }
    );
    listeners.push(gateway);

    let adminListener: ManagedListener | undefined;
    if (config.admin !== undefined) {
      const clock = options.adminClock ?? Date.now;
      const admin = createAdminInterface({
        auth: {
          callerKeys: loadPinnedCallerKeys(
            config.admin.keysFile,
            options.trustedUid === undefined ? {} : { trustedUid: options.trustedUid }
          ),
          replayWindowSeconds: config.admin.replayWindowSeconds,
          nonces: createInMemoryNonceStore(),
          processStartSeconds: Math.floor(clock() / 1000),
          nowMs: clock,
        },
        store,
        master,
        logger: log,
      });
      adminListener = createManagedListener(createAdminHandler(admin), {
        ...limitsOf(config),
        maxConnections: ADMIN_MAX_CONNECTIONS,
        ...(tls === undefined ? {} : { tls }),
      });
      listeners.push(adminListener);
    }

    const address = await gateway.listen(config.listen.host, config.listen.port);
    const adminAddress =
      adminListener === undefined || config.admin === undefined
        ? undefined
        : await adminListener.listen(config.admin.host, config.admin.port);
    log.service({ event: 'service', message: 'listening', detail: String(address.port) });

    let stopping: Promise<{ forced: boolean }> | undefined;
    return {
      tenantServer: gateway.server,
      address,
      ...(adminAddress === undefined ? {} : { adminAddress }),
      stop() {
        stopping ??= (async () => {
          log.service({ event: 'service', message: 'draining' });
          const results = await Promise.all(listeners.map((l) => l.stop(config.shutdownGraceMs)));
          store.close();
          const forced = results.some((r) => r.forced);
          log.service({
            event: 'service',
            message: forced ? 'stopped, connections cut' : 'stopped',
          });
          return { forced };
        })();
        return stopping;
      },
    };
  } catch (error) {
    await Promise.all(listeners.map((l) => l.stop(0)));
    store.close();
    throw error;
  }
}
