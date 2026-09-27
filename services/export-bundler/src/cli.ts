#!/usr/bin/env node
import { createFileDrainFlag } from './drainFlag.js';
import { createDrainFlagStore, flagPathFor } from './drainFlagStore.js';
import { createDockerContainerRunner } from './containerRunner.js';
import { createHttpGhostExportClient } from './ghostExportClient.js';
import { createHttpGhostProbe } from './ghostProbe.js';
import { createFileAuditLog } from './auditLog.js';
import { runExport } from './exportRunner.js';
import { createPromptedTokenSource } from './operatorToken.js';
import { createDockerStatusProbe } from './supportAccountProbe.js';
import { parseSupportGrant, type SupportGrant } from './supportGrant.js';

/**
 * The trigger this story owns, run by a person inside a support grant they
 * have already opened: this CLI never un-suspends or re-suspends the
 * support account, and it asks for the break-glass token on stdin once the
 * export colour is up. What calls this later -- the portal's backend --
 * is not built yet.
 */
export interface CliOptions {
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly deliveredTo: string;
  readonly image: string;
  readonly volume: string;
  readonly mountPath: string;
  readonly grant: SupportGrant;
  /** The tenant's own `age` recipient, the one its backups are encrypted to. */
  readonly ageRecipient: string;
  readonly destDir: string;
  readonly flagDir: string;
  readonly auditLogPath: string;
  readonly loopbackPort: number;
  /**
   * Every env var the tenant's own container boots with (storage config,
   * `url`, database connection, the break-glass adapter's settings),
   * forwarded verbatim to both the status probe and the export colour.
   */
  readonly env: Readonly<Record<string, string>>;
}

export const SUPPORT_IDENTITY_ENV = 'adapters__sso__BreakGlassSSO__supportIdentity';

function flagValue(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function requireFlag(argv: readonly string[], name: string): string {
  const value = flagValue(argv, name);
  if (!value) throw new Error(`missing required flag --${name}`);
  return value;
}

function collectEnvFlags(argv: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--env') continue;
    const pair = argv[i + 1];
    const eq = pair?.indexOf('=') ?? -1;
    if (!pair || eq <= 0) throw new Error('--env expects KEY=VALUE');
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  // First, so a missing grant is refused before any other flag is read.
  const grant = parseSupportGrant(
    flagValue(argv, 'grant-lane'),
    flagValue(argv, 'grant-reference')
  );
  const env = collectEnvFlags(argv);
  if (!env[SUPPORT_IDENTITY_ENV]) {
    throw new Error(
      `--env ${SUPPORT_IDENTITY_ENV}=<address> is required: it names the support account`
    );
  }
  return {
    grant,
    tenantId: requireFlag(argv, 'tenant-id'),
    requestedBy: requireFlag(argv, 'requested-by'),
    deliveredTo: requireFlag(argv, 'delivered-to'),
    image: requireFlag(argv, 'image'),
    volume: requireFlag(argv, 'volume'),
    mountPath: requireFlag(argv, 'mount-path'),
    ageRecipient: requireFlag(argv, 'age-recipient'),
    destDir: requireFlag(argv, 'dest-dir'),
    flagDir: requireFlag(argv, 'flag-dir'),
    auditLogPath: requireFlag(argv, 'audit-log'),
    loopbackPort: Number(requireFlag(argv, 'loopback-port')),
    env,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const opts = parseArgs(argv);
  const colourId = `${opts.tenantId}-export-${process.pid}`;
  const supportIdentity = opts.env[SUPPORT_IDENTITY_ENV]!;
  const volumes = [{ volume: opts.volume, mountPath: opts.mountPath }];

  const result = await runExport(
    {
      drainFlags: createDrainFlagStore(opts.flagDir),
      readDrainFlag: (id) => createFileDrainFlag(flagPathFor(opts.flagDir, id)),
      supportAccount: createDockerStatusProbe({ image: opts.image, env: opts.env, volumes }),
      containerRunner: createDockerContainerRunner({
        containerName: colourId,
        image: opts.image,
        loopbackPort: opts.loopbackPort,
        env: opts.env,
        volumes,
      }),
      probe: createHttpGhostProbe(2000),
      exportClient: createHttpGhostExportClient(
        createPromptedTokenSource(
          process.stdin,
          process.stderr,
          `export-bundler: the export colour is up. Mint a break-glass token now for tenant ` +
            `"${opts.tenantId}", identity ${supportIdentity}, lifetime 600s or less, ` +
            `and paste it on one line:`
        ),
        10_000
      ),
      auditLog: createFileAuditLog(opts.auditLogPath),
      nowIso: () => new Date().toISOString(),
      healthTimeoutMs: 60_000,
      healthPollIntervalMs: 500,
    },
    {
      tenantId: opts.tenantId,
      requestedBy: opts.requestedBy,
      deliveredTo: opts.deliveredTo,
      colourId,
      destDir: opts.destDir,
      grant: opts.grant,
      supportIdentity,
      ageRecipient: opts.ageRecipient,
    }
  );

  console.log(`export-bundler: wrote ${result.archivePath}`);
  console.log(`export-bundler: manifest ${result.manifestPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    const error = err as Error;
    console.error(`export-bundler: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
