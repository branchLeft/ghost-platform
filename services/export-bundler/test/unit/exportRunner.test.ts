import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runExport,
  GhostNeverBecameHealthyError,
  type ExportRunnerDeps,
} from '../../src/exportRunner.js';
import { UndrainedColourError } from '../../src/drainGate.js';
import type { DrainFlag } from '../../src/drainFlag.js';
import type { ContainerRunner } from '../../src/containerRunner.js';
import type { GhostExportClient } from '../../src/ghostExportClient.js';
import type { GhostProbe } from '../../src/ghostProbe.js';
import type { AuditRecorder, ExportAuditEntry } from '../../src/auditLog.js';

interface Recording {
  drainSetCalls: string[];
  drainClearCalls: string[];
  containerStarted: boolean;
  containerStopped: boolean;
  exportCalls: string[];
  auditEntries: ExportAuditEntry[];
}

function fakeDeps(overrides: {
  flagIsSet?: boolean;
  containerFails?: boolean;
  probeHealthy?: boolean;
  exportFails?: boolean;
}): { deps: ExportRunnerDeps; recording: Recording } {
  const recording: Recording = {
    drainSetCalls: [],
    drainClearCalls: [],
    containerStarted: false,
    containerStopped: false,
    exportCalls: [],
    auditEntries: [],
  };

  const flag: DrainFlag = { isSet: () => overrides.flagIsSet ?? true };

  const containerRunner: ContainerRunner = {
    async start() {
      recording.containerStarted = true;
      if (overrides.containerFails) throw new Error('container sabotage failure');
      return { baseUrl: 'http://127.0.0.1:1' };
    },
    async stop() {
      recording.containerStopped = true;
    },
  };

  const probe: GhostProbe = {
    async isHealthy() {
      return overrides.probeHealthy ?? true;
    },
  };

  const exportClient: GhostExportClient = {
    async fetchContentAndSettings() {
      recording.exportCalls.push('content_and_settings');
      if (overrides.exportFails) throw new Error('export sabotage failure');
      return { filename: 'ghost.json', contentType: 'application/json', body: Buffer.from('{}') };
    },
    async fetchPostAnalytics() {
      recording.exportCalls.push('post_analytics');
      return {
        filename: 'ghost.analytics.csv',
        contentType: 'text/csv',
        body: Buffer.from('a,b\n'),
      };
    },
  };

  const auditLog: AuditRecorder = {
    async record(entry) {
      recording.auditEntries.push(entry);
    },
  };

  const deps: ExportRunnerDeps = {
    drainFlags: {
      set: async (colourId) => {
        recording.drainSetCalls.push(colourId);
      },
      clear: async (colourId) => {
        recording.drainClearCalls.push(colourId);
      },
    },
    readDrainFlag: () => flag,
    containerRunner,
    probe,
    exportClient,
    auditLog,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    healthTimeoutMs: 200,
    healthPollIntervalMs: 10,
  };

  return { deps, recording };
}

describe('runExport', () => {
  let destDir: string;

  beforeEach(async () => {
    destDir = await mkdtemp(join(tmpdir(), 'export-bundler-run-test-'));
  });

  afterEach(async () => {
    await rm(destDir, { recursive: true, force: true });
  });

  const baseRequest = {
    tenantId: 'tenant-1',
    requestedBy: 'rob@branchleft.co.uk',
    deliveredTo: 'rob@branchleft.co.uk',
    colourId: 'tenant-1-export-1',
  };

  it('runs the full lifecycle: drains, starts, exports both files, bundles, audits, stops', async () => {
    const { deps, recording } = fakeDeps({});
    const result = await runExport(deps, { ...baseRequest, destDir });

    expect(recording.drainSetCalls).toEqual(['tenant-1-export-1']);
    expect(recording.containerStarted).toBe(true);
    expect(recording.exportCalls.sort()).toEqual(['content_and_settings', 'post_analytics']);
    expect(recording.containerStopped).toBe(true);
    expect(recording.drainClearCalls).toEqual(['tenant-1-export-1']);
    expect(recording.auditEntries).toHaveLength(1);
    expect(recording.auditEntries[0]).toMatchObject({
      tenantId: 'tenant-1',
      requestedBy: 'rob@branchleft.co.uk',
      deliveredTo: 'rob@branchleft.co.uk',
    });

    expect(result.manifest.included.map((e) => e.name).sort()).toEqual([
      'content_and_settings',
      'post_analytics',
    ]);
    const files = await readdir(destDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^tenant-1-export-.*\.tar$/);
  });

  it('the manifest names the known gaps -- media, members/subscriptions, comments, analytics beyond the CSV', async () => {
    const { deps } = fakeDeps({});
    const result = await runExport(deps, { ...baseRequest, destDir });
    expect(result.manifest.excluded.map((g) => g.name)).toEqual([
      'media',
      'members_and_subscriptions',
      'comments',
      'analytics_beyond_post_csv',
    ]);
  });

  it('refuses -- UndrainedColourError -- when the colour reads as undrained, and never starts the container or calls the exports', async () => {
    const { deps, recording } = fakeDeps({ flagIsSet: false });
    await expect(runExport(deps, { ...baseRequest, destDir })).rejects.toThrow(
      UndrainedColourError
    );
    expect(recording.containerStarted).toBe(false);
    expect(recording.exportCalls).toEqual([]);
    expect(recording.auditEntries).toEqual([]);
    expect(await readdir(destDir)).toEqual([]);
  });

  it('stops the container even when Ghost never becomes healthy', async () => {
    const { deps, recording } = fakeDeps({ probeHealthy: false });
    await expect(runExport(deps, { ...baseRequest, destDir })).rejects.toThrow(
      GhostNeverBecameHealthyError
    );
    expect(recording.containerStopped).toBe(true);
    expect(recording.drainClearCalls).toEqual(['tenant-1-export-1']);
    expect(recording.auditEntries).toEqual([]);
  });

  it('stops the container even when the export calls fail', async () => {
    const { deps, recording } = fakeDeps({ exportFails: true });
    await expect(runExport(deps, { ...baseRequest, destDir })).rejects.toThrow(
      'export sabotage failure'
    );
    expect(recording.containerStopped).toBe(true);
    expect(recording.auditEntries).toEqual([]);
  });

  it('succeeds with a request that carries no subscription or liveness field at all -- structurally, there is nothing to gate on', async () => {
    const { deps } = fakeDeps({});
    const request = { ...baseRequest, destDir };
    // TypeScript's own ExportRequest type has no `subscriptionActive` or
    // `liveColourHealthy` field to set here -- this is the structural half
    // of LLD-8 §08b's "never gated behind an active subscription or a
    // running Ghost" (see exportRunner.ts's own comment on ExportRequest).
    expect('subscriptionActive' in request).toBe(false);
    expect('liveColourHealthy' in request).toBe(false);
    await expect(runExport(deps, request)).resolves.toBeDefined();
  });

  it('writes an archive containing both real export files and the manifest', async () => {
    const { deps } = fakeDeps({});
    const result = await runExport(deps, { ...baseRequest, destDir });

    const { execFile } = await import('node:child_process');
    const listing = await new Promise<string>((resolve, reject) => {
      execFile(
        'tar',
        ['-tf', result.archivePath],
        { env: { PATH: process.env.PATH ?? '' } },
        (err, stdout, stderr) =>
          err ? reject(new Error(`${err.message}: ${stderr}`)) : resolve(stdout)
      );
    });
    expect(listing).toContain('ghost.json');
    expect(listing).toContain('ghost.analytics.csv');
    expect(listing).toContain('manifest.json');
  });
});
