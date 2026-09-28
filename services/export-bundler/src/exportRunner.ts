import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DrainFlag } from './drainFlag.js';
import type { DrainFlagStore } from './drainFlagStore.js';
import { assertDrained } from './drainGate.js';
import type { ContainerRunner } from './containerRunner.js';
import type { ExportFile, GhostExportClient } from './ghostExportClient.js';
import type { GhostProbe } from './ghostProbe.js';
import { waitUntilHealthy } from './ghostProbe.js';
import { buildManifest, type ExportManifest } from './manifest.js';
import { writeEncryptedArchive, writeManifestSidecar } from './archive.js';
import type { AuditRecorder } from './auditLog.js';
import { assertAgeRecipient, recipientFingerprint } from './ageEncryption.js';
import {
  assertColourOnScratch,
  pointAtScratch,
  type DatabaseTarget,
  type ScratchDatabase,
} from './scratchDatabase.js';
import {
  assertIsSupportRole,
  assertSupportAccountActive,
  parseSupportGrant,
  SupportAccountNotActiveError,
  type SupportAccountStatusReader,
  type SupportGrant,
} from './supportGrant.js';

export interface ExportRunnerDeps {
  readonly drainFlags: DrainFlagStore;
  readonly readDrainFlag: (colourId: string) => DrainFlag;
  readonly supportAccount: SupportAccountStatusReader;
  /** The run's own copy of the tenant's database; the colour runs against nothing else. */
  readonly scratch: ScratchDatabase;
  readonly containerRunner: ContainerRunner;
  readonly probe: GhostProbe;
  readonly exportClient: GhostExportClient;
  readonly auditLog: AuditRecorder;
  readonly nowIso: () => string;
  readonly healthTimeoutMs: number;
  readonly healthPollIntervalMs: number;
  /** The `age` binary; tests point it elsewhere. */
  readonly ageCommand?: string;
}

/**
 * Deliberately carries no subscription state, no billing status and no
 * "is the tenant's live colour up" field -- LLD-8 §08b: "it must work when
 * the relationship has ended badly... the export path cannot be gated
 * behind an active subscription or a running Ghost." What it does carry is
 * the support grant the export runs under, and the tenant's own `age`
 * recipient.
 */
export interface ExportRequest {
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly deliveredTo: string;
  readonly colourId: string;
  readonly destDir: string;
  readonly grant: SupportGrant;
  /** From the tenant's rendered break-glass config (tenantConfig.ts), never typed by the operator. */
  readonly supportIdentity: string;
  /** The descriptor's `backup.encryptionRecipient`, bound in tenantConfig.ts. */
  readonly ageRecipient: string;
  /**
   * The colour's environment before its database is pointed at the copy:
   * the tenant's own, with colourIsolation.ts's overrides applied.
   */
  readonly colourBaseEnv: Readonly<Record<string, string>>;
  /** The tenant's live database, which the colour must never be pointed at. */
  readonly liveDatabase: DatabaseTarget;
}

export interface ExportResult {
  readonly archivePath: string;
  readonly manifestPath: string;
  readonly archiveSha256: string;
  readonly manifest: ExportManifest;
}

export class GhostNeverBecameHealthyError extends Error {
  constructor(colourId: string, timeoutMs: number) {
    super(`Ghost on colour "${colourId}" never answered 200 within ${timeoutMs}ms`);
    this.name = 'GhostNeverBecameHealthyError';
  }
}

const CONTENT_ENTRY = 'content_and_settings.json';
const ANALYTICS_ENTRY = 'post_analytics.csv';

/**
 * The bundler LLD-8 §08b describes, run as a support grant (LLD-5 §05)
 * against a copy of the tenant's database (owner ruling, "the copy"):
 * refuse unless a grant is in force and the support account is active; make
 * the copy; start the tenant's image on a drained colour pointed at the
 * copy, and at nothing else; call Ghost's two existing admin exports; bundle
 * one archive encrypted to the tenant's recipient; record the audit entry.
 * The colour, then the copy, then the drain flag are removed on every exit
 * path -- signals included, through cleanup.ts.
 */
export async function runExport(
  deps: ExportRunnerDeps,
  request: ExportRequest
): Promise<ExportResult> {
  const grant = parseSupportGrant(request.grant.lane, request.grant.reference);
  assertAgeRecipient(request.ageRecipient);
  const { account } = await deps.supportAccount.readPreflight(request.supportIdentity);
  if (account === null) throw new SupportAccountNotActiveError(request.supportIdentity, null);
  assertIsSupportRole(request.supportIdentity, account.roles);
  assertSupportAccountActive(request.supportIdentity, account.status);

  // A new colour always boots drained (LLD-4 §U3b/§U7): the flag is set
  // before anything starts, then re-read rather than trusted, so this
  // function's own refusal path exercises the exact same check a stray
  // live colour would fail.
  await deps.drainFlags.set(request.colourId);
  try {
    assertDrained(deps.readDrainFlag(request.colourId), request.colourId);
    try {
      const copy = await deps.scratch.prepare();
      const colourEnv = pointAtScratch(request.colourBaseEnv, copy);
      // Before the colour exists: a colour pointed at the live database
      // must never boot, because Ghost acts on its database during boot.
      assertColourOnScratch(colourEnv, copy.target, request.liveDatabase);
      const { baseUrl } = await deps.containerRunner.start(colourEnv, {
        network: copy.network,
        volumes: copy.colourVolumes,
      });
      try {
        const healthy = await waitUntilHealthy(
          deps.probe,
          baseUrl,
          deps.healthTimeoutMs,
          deps.healthPollIntervalMs
        );
        if (!healthy) {
          throw new GhostNeverBecameHealthyError(request.colourId, deps.healthTimeoutMs);
        }
        // Again, before any export call, on what Docker says the running
        // colour was actually given.
        assertColourOnScratch(
          await deps.containerRunner.readEnv(),
          copy.target,
          request.liveDatabase
        );

        const [contentAndSettings, postAnalytics] = await Promise.all([
          deps.exportClient.fetchContentAndSettings(baseUrl),
          deps.exportClient.fetchPostAnalytics(baseUrl),
        ]);
        return await bundle(deps, request, grant, contentAndSettings, postAnalytics);
      } finally {
        await deps.containerRunner.stop();
      }
    } finally {
      await deps.scratch.destroy();
    }
  } finally {
    await deps.drainFlags.clear(request.colourId);
  }
}

async function bundle(
  deps: ExportRunnerDeps,
  request: ExportRequest,
  grant: SupportGrant,
  contentAndSettings: ExportFile,
  postAnalytics: ExportFile
): Promise<ExportResult> {
  const generatedAt = deps.nowIso();
  const fingerprint = recipientFingerprint(request.ageRecipient);
  const manifest = buildManifest(
    request.tenantId,
    generatedAt,
    {
      encrypted: true,
      format: 'age',
      recipient: request.ageRecipient,
      recipientFingerprint: fingerprint,
    },
    [
      { name: 'content_and_settings', path: CONTENT_ENTRY },
      { name: 'post_analytics', path: ANALYTICS_ENTRY },
    ]
  );
  const manifestJson = JSON.stringify(manifest, null, 2);

  const stem = join(
    request.destDir,
    `${request.tenantId}-export-${generatedAt.replace(/[:.]/g, '')}`
  );
  const archivePath = `${stem}.tar.age`;
  const manifestPath = `${stem}.manifest.json`;
  await writeEncryptedArchive(
    archivePath,
    [
      { name: CONTENT_ENTRY, data: contentAndSettings.body },
      { name: ANALYTICS_ENTRY, data: postAnalytics.body },
      { name: 'manifest.json', data: manifestJson },
    ],
    Math.floor(Date.parse(generatedAt) / 1000),
    request.ageRecipient,
    deps.ageCommand
  );
  // An archive without its audit record must not outlive the run: any
  // failure from here on removes both files before it is reported.
  try {
    await writeManifestSidecar(manifestPath, manifestJson);
    const archiveSha256 = createHash('sha256')
      .update(await readFile(archivePath))
      .digest('hex');
    await deps.auditLog.record({
      tenantId: request.tenantId,
      requestedBy: request.requestedBy,
      occurredAt: generatedAt,
      contents: manifest.included.map((entry) => entry.name),
      deliveredTo: request.deliveredTo,
      grant: { lane: grant.lane, reference: grant.reference },
      supportIdentity: request.supportIdentity,
      encryptedTo: fingerprint,
      archiveSha256,
    });
    return { archivePath, manifestPath, manifest, archiveSha256 };
  } catch (err) {
    await rm(archivePath, { force: true });
    await rm(manifestPath, { force: true });
    throw err;
  }
}
