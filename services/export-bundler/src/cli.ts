#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileDrainFlag } from './drainFlag.js';
import { createDrainFlagStore, flagPathFor } from './drainFlagStore.js';
import { createDockerContainerRunner, type VolumeMount } from './containerRunner.js';
import { createHttpMediaProbe } from './mediaManifest.js';
import { createHttpGhostExportClient } from './ghostExportClient.js';
import { createHttpGhostProbe } from './ghostProbe.js';
import { createFileAuditLog } from './auditLog.js';
import { runExport } from './exportRunner.js';
import { createPromptedTokenSource } from './operatorToken.js';
import { createDockerStatusProbe } from './supportAccountProbe.js';
import { parseSupportGrant, type SupportGrant } from './supportGrant.js';
import { installSignalCleanup, processCleanup } from './cleanup.js';
import { createMysqlScratch, createSqliteScratch, databaseTargetOf } from './scratchDatabase.js';
import { isolateExportColour } from './colourIsolation.js';
import {
  bindTenant,
  loadComposeConfig,
  mediaBaseUrlOf,
  parseComposeConfig,
  parseDescriptorFacts,
  TenantConfigError,
} from './tenantConfig.js';

/**
 * The trigger this story owns, run by a person inside a support grant they
 * have already opened: this CLI never un-suspends or re-suspends the
 * support account, and it asks for the break-glass token on stdin once the
 * export colour is up. Whose data, as which account and to which key all
 * come from the tenant's own descriptor and rendered stack (see
 * tenantConfig.ts); there is deliberately no flag for any of them.
 */
export interface CliOptions {
  readonly grant: SupportGrant;
  readonly descriptorPath: string;
  /** Defaults to render-core's stackDirectory(): /opt/branchleft/<slug>. */
  readonly stackDir: string | undefined;
  /** Defaults to render-core's secretsEnvPath(): /etc/branchleft/<slug>.env. */
  readonly secretsEnv: string | undefined;
  /** Defaults to render-core's imageEnvPath(): /etc/branchleft/<slug>.image.env. */
  readonly imageEnv: string | undefined;
  /** The operator's statement of the recipient; refused unless it is the descriptor's. */
  readonly ageRecipient: string;
  readonly requestedBy: string;
  readonly deliveredTo: string;
  readonly destDir: string;
  readonly flagDir: string;
  readonly auditLogPath: string;
  readonly loopbackPort: number;
  /** The day after which the tenant's public media addresses stop working, YYYY-MM-DD. */
  readonly erasureDate: string;
}

const RETIRED_FLAGS = [
  '--env',
  '--tenant-id',
  '--image',
  '--volume',
  '--mount-path',
  '--break-glass-identity',
];

function flagValue(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function requireFlag(argv: readonly string[], name: string): string {
  const value = flagValue(argv, name);
  if (!value) throw new Error(`missing required flag --${name}`);
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  // First, so a missing grant is refused before any other flag is read.
  const grant = parseSupportGrant(
    flagValue(argv, 'grant-lane'),
    flagValue(argv, 'grant-reference')
  );
  const retired = RETIRED_FLAGS.find((flag) => argv.includes(flag));
  if (retired) {
    throw new TenantConfigError(
      `${retired} is not accepted: the tenant's environment, image, volumes and support ` +
        `identity come from its own rendered stack`
    );
  }
  return {
    grant,
    descriptorPath: requireFlag(argv, 'descriptor'),
    stackDir: flagValue(argv, 'stack-dir'),
    secretsEnv: flagValue(argv, 'secrets-env'),
    imageEnv: flagValue(argv, 'image-env'),
    ageRecipient: requireFlag(argv, 'age-recipient'),
    requestedBy: requireFlag(argv, 'requested-by'),
    deliveredTo: requireFlag(argv, 'delivered-to'),
    destDir: requireFlag(argv, 'dest-dir'),
    flagDir: requireFlag(argv, 'flag-dir'),
    auditLogPath: requireFlag(argv, 'audit-log'),
    loopbackPort: Number(requireFlag(argv, 'loopback-port')),
    erasureDate: requireFlag(argv, 'erasure-date'),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  // First: a Ctrl-C at any later point removes whatever the run has created
  // (colour, scratch copy, network, env files) before the process exits.
  installSignalCleanup();
  const opts = parseArgs(argv);

  let descriptorJson: unknown;
  try {
    descriptorJson = JSON.parse(await readFile(opts.descriptorPath, 'utf8'));
  } catch {
    throw new TenantConfigError(`the descriptor at ${opts.descriptorPath} is not readable JSON`);
  }
  const descriptor = parseDescriptorFacts(descriptorJson);
  const slug = descriptor.slug;
  const runtime = parseComposeConfig(
    await loadComposeConfig({
      composeFile: join(opts.stackDir ?? `/opt/branchleft/${slug}`, 'compose.yml'),
      envFiles: [
        opts.secretsEnv ?? `/etc/branchleft/${slug}.env`,
        opts.imageEnv ?? `/etc/branchleft/${slug}.image.env`,
      ],
    })
  );
  const ageRecipient = bindTenant(descriptor, runtime, opts.ageRecipient);

  const colourId = `${slug}-export-${process.pid}`;
  // runExport clears the flag itself on every normal exit; this covers a signal.
  processCleanup.register(`drain flag ${colourId}`, () =>
    rmSync(flagPathFor(opts.flagDir, colourId), { force: true })
  );
  const volumes: VolumeMount[] = runtime.volumes.map((v) => ({
    volume: v.source,
    mountPath: v.target,
    readOnly: v.readOnly,
  }));
  const liveDatabase = databaseTargetOf(runtime.env);
  const scratch =
    liveDatabase.kind === 'mysql'
      ? createMysqlScratch({
          runId: colourId,
          live: liveDatabase,
          liveUser: runtime.env.database__connection__user ?? '',
          livePassword: runtime.env.database__connection__password ?? '',
          liveUsesTls: Object.keys(runtime.env).some((k) =>
            k.startsWith('database__connection__ssl')
          ),
        })
      : createSqliteScratch({
          runId: colourId,
          image: runtime.image,
          tenantVolumes: volumes,
          live: liveDatabase,
          owner: runtime.user,
        });

  const container = { user: runtime.user, volumes };
  const result = await runExport(
    {
      drainFlags: createDrainFlagStore(opts.flagDir),
      readDrainFlag: (id) => createFileDrainFlag(flagPathFor(opts.flagDir, id)),
      supportAccount: createDockerStatusProbe({ ...container, image: runtime.image }, runtime.env),
      scratch,
      containerRunner: createDockerContainerRunner({
        ...container,
        containerName: colourId,
        image: runtime.image,
        loopbackPort: opts.loopbackPort,
        network: null,
      }),
      probe: createHttpGhostProbe(2000),
      exportClient: createHttpGhostExportClient(
        createPromptedTokenSource(
          process.stdin,
          process.stderr,
          `export-bundler: the export colour is up. Mint a break-glass token now for tenant ` +
            `"${slug}", identity ${runtime.supportIdentity}, lifetime 600s or less, ` +
            `and paste it on one line:`
        ),
        10_000
      ),
      mediaProbe: createHttpMediaProbe(10_000),
      auditLog: createFileAuditLog(opts.auditLogPath),
      nowIso: () => new Date().toISOString(),
      healthTimeoutMs: 60_000,
      healthPollIntervalMs: 500,
    },
    {
      tenantId: slug,
      requestedBy: opts.requestedBy,
      deliveredTo: opts.deliveredTo,
      colourId,
      destDir: opts.destDir,
      grant: opts.grant,
      supportIdentity: runtime.supportIdentity,
      ageRecipient,
      colourBaseEnv: isolateExportColour(runtime.env),
      liveDatabase,
      media: {
        baseUrl: mediaBaseUrlOf(runtime.env),
        erasureDate: opts.erasureDate,
      },
    }
  );

  console.log(`export-bundler: wrote ${result.archivePath}`);
  console.log(`export-bundler: sha256 ${result.archiveSha256}`);
  console.log(`export-bundler: manifest ${result.manifestPath}`);
  console.log(`export-bundler: complete ${String(result.manifest.complete)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    const error = err as Error;
    console.error(`export-bundler: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
