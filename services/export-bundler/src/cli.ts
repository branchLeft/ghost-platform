#!/usr/bin/env node
import { createFileDrainFlag } from './drainFlag.js';
import { createDrainFlagStore, flagPathFor } from './drainFlagStore.js';
import { createDockerContainerRunner } from './containerRunner.js';
import { createHttpGhostExportClient } from './ghostExportClient.js';
import { createBreakGlassMinter } from './breakGlassToken.js';
import { createHttpGhostProbe } from './ghostProbe.js';
import { createFileAuditLog } from './auditLog.js';
import { runExport } from './exportRunner.js';

/**
 * The trigger this story owns: "triggering an export starts that tenant's
 * image on a drained colour...". What calls this -- the portal's own
 * backend -- is not built yet (LLD-8 §08b describes the portal, not this
 * component), so this CLI is the seam a caller invokes today and the
 * portal invokes tomorrow, the same relationship adminApi.ts's own comment
 * describes for /reconcile's Admin API call.
 */
export interface CliOptions {
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly deliveredTo: string;
  readonly image: string;
  readonly volume: string;
  readonly mountPath: string;
  /** Base64url, 32 raw bytes -- see breakGlassToken.ts. */
  readonly breakGlassPrivateKey: string;
  /** Must equal the tenant's own `adapters__sso__BreakGlassSSO__tenant`. */
  readonly breakGlassTenant: string;
  /** Must equal the tenant's own `adapters__sso__BreakGlassSSO__supportIdentity`. */
  readonly breakGlassIdentity: string;
  readonly destDir: string;
  readonly flagDir: string;
  readonly auditLogPath: string;
  readonly loopbackPort: number;
  /**
   * Every other env var the tenant's own container needs (storage
   * config, `url`, database connection) -- this package renders no
   * compose file and has no opinion on a tenant's storage tier, so it
   * takes them verbatim rather than guessing at a sqlite/local-disk
   * default that would be wrong for a real, paying tenant. In
   * production these come from the same rendered env a tenant's own
   * colour already boots with; here they arrive as repeated `--env`
   * flags.
   */
  readonly env: Readonly<Record<string, string>>;
}

function requireFlag(argv: readonly string[], name: string): string {
  const idx = argv.indexOf(`--${name}`);
  const value = idx >= 0 ? argv[idx + 1] : undefined;
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
  return {
    tenantId: requireFlag(argv, 'tenant-id'),
    requestedBy: requireFlag(argv, 'requested-by'),
    deliveredTo: requireFlag(argv, 'delivered-to'),
    image: requireFlag(argv, 'image'),
    volume: requireFlag(argv, 'volume'),
    mountPath: requireFlag(argv, 'mount-path'),
    breakGlassPrivateKey: requireFlag(argv, 'break-glass-private-key'),
    breakGlassTenant: requireFlag(argv, 'break-glass-tenant'),
    breakGlassIdentity: requireFlag(argv, 'break-glass-identity'),
    destDir: requireFlag(argv, 'dest-dir'),
    flagDir: requireFlag(argv, 'flag-dir'),
    auditLogPath: requireFlag(argv, 'audit-log'),
    loopbackPort: Number(requireFlag(argv, 'loopback-port')),
    env: collectEnvFlags(argv),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const opts = parseArgs(argv);
  const colourId = `${opts.tenantId}-export-${process.pid}`;

  const result = await runExport(
    {
      drainFlags: createDrainFlagStore(opts.flagDir),
      readDrainFlag: (id) => createFileDrainFlag(flagPathFor(opts.flagDir, id)),
      containerRunner: createDockerContainerRunner({
        containerName: colourId,
        image: opts.image,
        loopbackPort: opts.loopbackPort,
        env: opts.env,
        volumes: [{ volume: opts.volume, mountPath: opts.mountPath }],
      }),
      probe: createHttpGhostProbe(2000),
      exportClient: createHttpGhostExportClient(
        createBreakGlassMinter(
          Buffer.from(opts.breakGlassPrivateKey, 'base64url'),
          opts.breakGlassTenant,
          opts.breakGlassIdentity
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
    }
  );

  console.log(`export-bundler: wrote ${result.archivePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`export-bundler: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
