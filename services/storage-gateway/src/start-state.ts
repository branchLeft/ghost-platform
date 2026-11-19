/**
 * Builds and starts the state process: a tenant's Pulumi state, on its own
 * listener, with its own upstream key, its own master secret and its own
 * credential store. It shares code with the media process and nothing at
 * run time: the key files it reads are the state shard's key, the master it
 * loads is the state master, and the store it opens holds state credentials
 * only, so a media credential cannot be presented to it and a state one
 * cannot reach the media listener.
 */
import { constants, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createAdminHandler } from './admin-listener.js';
import { ConfigError, type GatewayConfig } from './config.js';
import { createAdminInterface } from './credentials/admin.js';
import { createInMemoryNonceStore, loadPinnedCallerKeys } from './credentials/adminAuth.js';
import { loadMasterSecret } from './credentials/masterSecret.js';
import { createSigningSecretSource } from './credentials/secretSource.js';
import { MIGRATIONS_FOLDER, SqliteCredentialStore } from './credentials/store.js';
import { sweepSpoolDir } from './body.js';
import { createManagedListener, type ManagedListener } from './listener.js';
import { createStateLimits } from './limits/state.js';
import { createTenantRateLimiter, createWriteKillSwitches } from './limits/index.js';
import { createLog } from './logging.js';
import { readOwnerOnlyFile } from './secretFile.js';
import { createInMemoryReplayGuard } from './replay.js';
import { SigV4Verifier } from './sigv4-verifier.js';
import { createStateListener } from './state-server.js';
import { createStateUpstream } from './state-upstream.js';
import {
  ADMIN_MAX_CONNECTIONS,
  READINESS_PROBE_KEY_ID,
  TLS_KEY_FILE_MAX_BYTES,
  limitsOf,
  secretText,
  type RunningGateway,
  type StartOptions,
} from './start.js';
import { UpstreamCredentials } from './upstream.js';

/** Builds the state service from its configuration and starts listening. Opens nothing before the settings are checked. */
export async function startStateGateway(
  config: GatewayConfig,
  options: StartOptions
): Promise<RunningGateway> {
  if (config.profile !== 'state' || config.stateBucket === undefined) {
    throw new ConfigError('this entry serves the state profile only; use the media entry');
  }
  const stateBucket = config.stateBucket;
  const log = createLog(options.sink);
  // The state master secret: the file this process's own environment names, never the media one.
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
  if (swept > 0) {
    log.service({
      event: 'service',
      message: 'removed leftover spool files',
      detail: String(swept),
    });
  }

  const store = SqliteCredentialStore.open(
    config.storePath,
    MIGRATIONS_FOLDER,
    config.storeAnchorPath
  );
  const listeners: ManagedListener[] = [];
  try {
    const verifier = new SigV4Verifier({
      region: config.region,
      secrets: createSigningSecretSource(store, master, 'state'),
    });
    const replay = createInMemoryReplayGuard({
      windowMs: verifier.clockWindowMs,
      ...(options.replayLimit === undefined ? {} : { limit: options.replayLimit }),
    });
    const switches = createWriteKillSwitches(
      config.writeSwitchesFile === undefined ? {} : { path: config.writeSwitchesFile }
    );
    const limits = createStateLimits({
      rate: createTenantRateLimiter({ default: config.tenantRate }),
      switches,
    });
    const upstream = createStateUpstream({
      endpoint: config.upstream.endpoint,
      region: config.upstream.region,
      bucket: stateBucket,
      credentials: upstreamCredentials,
      deadlineMs: config.upstream.deadlineMs,
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

    const gateway = createStateListener(
      {
        verifier,
        credentials: store,
        upstream,
        log,
        spoolDir: config.spoolDir,
        ...(config.spoolThresholdBytes === undefined
          ? {}
          : { spoolThresholdBytes: config.spoolThresholdBytes }),
        maxBodyBytes: config.maxBodyBytes,
        maxConcurrentWrites: config.maxConcurrentUploads,
        maxConcurrentWritesPerTenant: config.maxConcurrentUploadsPerTenant,
        replay,
        limits,
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
        profile: 'state',
        stateBucket,
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
      switches,
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
