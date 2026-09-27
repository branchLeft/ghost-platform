import { join } from 'node:path';
import type { DrainFlag } from './drainFlag.js';
import type { DrainFlagStore } from './drainFlagStore.js';
import { assertDrained } from './drainGate.js';
import type { ContainerRunner } from './containerRunner.js';
import type { GhostExportClient } from './ghostExportClient.js';
import type { GhostProbe } from './ghostProbe.js';
import { waitUntilHealthy } from './ghostProbe.js';
import { buildManifest, type ExportManifest } from './manifest.js';
import { writeTarArchive } from './archive.js';
import type { AuditRecorder } from './auditLog.js';

export interface ExportRunnerDeps {
  readonly drainFlags: DrainFlagStore;
  readonly readDrainFlag: (colourId: string) => DrainFlag;
  readonly containerRunner: ContainerRunner;
  readonly probe: GhostProbe;
  readonly exportClient: GhostExportClient;
  readonly auditLog: AuditRecorder;
  readonly nowIso: () => string;
  readonly healthTimeoutMs: number;
  readonly healthPollIntervalMs: number;
}

/**
 * Deliberately carries no subscription state, no billing status and no
 * "is the tenant's live colour up" field -- LLD-8 §08b: "it must work when
 * the relationship has ended badly... the export path cannot be gated
 * behind an active subscription or a running Ghost." There is structurally
 * nothing here to gate on: the request names the tenant and the colour to
 * export from, nothing else, so a suspended tenant and a tenant mid-
 * incident take the exact same path as any other.
 */
export interface ExportRequest {
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly deliveredTo: string;
  readonly colourId: string;
  readonly destDir: string;
}

export interface ExportResult {
  readonly archivePath: string;
  readonly manifest: ExportManifest;
}

export class GhostNeverBecameHealthyError extends Error {
  constructor(colourId: string, timeoutMs: number) {
    super(`Ghost on colour "${colourId}" never answered 200 within ${timeoutMs}ms`);
    this.name = 'GhostNeverBecameHealthyError';
  }
}

/**
 * The bundler LLD-8 §08b describes: start the tenant's image on a drained
 * colour, call Ghost's two existing admin exports, bundle one archive with
 * a manifest, record the audit entry, stop the image. The container is
 * always stopped in `finally` -- a failed export must not leave a stray
 * container behind any more than a successful one does.
 */
export async function runExport(
  deps: ExportRunnerDeps,
  request: ExportRequest
): Promise<ExportResult> {
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
    const manifest = buildManifest(request.tenantId, generatedAt, [
      { name: 'content_and_settings', path: contentAndSettings.filename },
      { name: 'post_analytics', path: postAnalytics.filename },
    ]);

    const archivePath = join(
      request.destDir,
      `${request.tenantId}-export-${generatedAt.replace(/[:.]/g, '')}.tar`
    );
    await writeTarArchive(archivePath, [
      { name: contentAndSettings.filename, data: contentAndSettings.body },
      { name: postAnalytics.filename, data: postAnalytics.body },
      { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    ]);

    await deps.auditLog.record({
      tenantId: request.tenantId,
      requestedBy: request.requestedBy,
      occurredAt: generatedAt,
      contents: manifest.included.map((entry) => entry.name),
      deliveredTo: request.deliveredTo,
    });

    return { archivePath, manifest };
  } finally {
    await deps.containerRunner.stop();
    await deps.drainFlags.clear(request.colourId);
  }
}
