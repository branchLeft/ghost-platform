import { join } from 'node:path';
import type { DrainFlag } from './drainFlag.js';
import type { DrainFlagStore } from './drainFlagStore.js';
import { assertDrained } from './drainGate.js';
import type { ContainerRunner } from './containerRunner.js';
import type { GhostExportClient } from './ghostExportClient.js';
import type { GhostProbe } from './ghostProbe.js';
import { waitUntilHealthy } from './ghostProbe.js';
import { buildManifest, type ExportManifest } from './manifest.js';
import { writeEncryptedArchive, writeManifestSidecar } from './archive.js';
import type { AuditRecorder } from './auditLog.js';
import { assertAgeRecipient, recipientFingerprint } from './ageEncryption.js';
import {
  assertSupportAccountActive,
  parseSupportGrant,
  type SupportAccountStatusReader,
  type SupportGrant,
} from './supportGrant.js';

export interface ExportRunnerDeps {
  readonly drainFlags: DrainFlagStore;
  readonly readDrainFlag: (colourId: string) => DrainFlag;
  readonly supportAccount: SupportAccountStatusReader;
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
  /** Must equal the tenant's own `adapters__sso__BreakGlassSSO__supportIdentity`. */
  readonly supportIdentity: string;
  readonly ageRecipient: string;
}

export interface ExportResult {
  readonly archivePath: string;
  readonly manifestPath: string;
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
 * The bundler LLD-8 §08b describes, run as a support grant (LLD-5 §05):
 * refuse unless a grant is in force and the support account is active,
 * start the tenant's image on a drained colour, call Ghost's two existing
 * admin exports, bundle one archive encrypted to the tenant's recipient,
 * record the audit entry, stop the image. Every refusal happens before
 * the drain flag is set or anything is started. The container is always
 * stopped in `finally`.
 */
export async function runExport(
  deps: ExportRunnerDeps,
  request: ExportRequest
): Promise<ExportResult> {
  const grant = parseSupportGrant(request.grant.lane, request.grant.reference);
  assertAgeRecipient(request.ageRecipient);
  assertSupportAccountActive(
    request.supportIdentity,
    await deps.supportAccount.readStatus(request.supportIdentity)
  );

  // A new colour always boots drained (LLD-4 §U3b/§U7): the flag is set
  // before anything starts, then re-read rather than trusted, so this
  // function's own refusal path exercises the exact same check a stray
  // live colour would fail.
  await deps.drainFlags.set(request.colourId);
  assertDrained(deps.readDrainFlag(request.colourId), request.colourId);

  const { baseUrl } = await deps.containerRunner.start();
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

    const [contentAndSettings, postAnalytics] = await Promise.all([
      deps.exportClient.fetchContentAndSettings(baseUrl),
      deps.exportClient.fetchPostAnalytics(baseUrl),
    ]);

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
    await writeManifestSidecar(manifestPath, manifestJson);

    await deps.auditLog.record({
      tenantId: request.tenantId,
      requestedBy: request.requestedBy,
      occurredAt: generatedAt,
      contents: manifest.included.map((entry) => entry.name),
      deliveredTo: request.deliveredTo,
      grant: { lane: grant.lane, reference: grant.reference },
      encryptedTo: fingerprint,
    });

    return { archivePath, manifestPath, manifest };
  } finally {
    await deps.containerRunner.stop();
    await deps.drainFlags.clear(request.colourId);
  }
}
