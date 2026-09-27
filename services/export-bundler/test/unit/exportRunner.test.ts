import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runExport,
  GhostNeverBecameHealthyError,
  type ExportRequest,
  type ExportRunnerDeps,
} from '../../src/exportRunner.js';
import { UndrainedColourError } from '../../src/drainGate.js';
import type { DrainFlag } from '../../src/drainFlag.js';
import type { ContainerRunner } from '../../src/containerRunner.js';
import type { GhostExportClient } from '../../src/ghostExportClient.js';
import type { GhostProbe } from '../../src/ghostProbe.js';
import type { AuditRecorder, ExportAuditEntry } from '../../src/auditLog.js';
import {
  AgeEncryptionError,
  InvalidAgeRecipientError,
  recipientFingerprint,
} from '../../src/ageEncryption.js';
import {
  NoSupportGrantError,
  SupportAccountNotActiveError,
  type SupportGrant,
} from '../../src/supportGrant.js';
import {
  decryptAge,
  filesContaining,
  filesUnder,
  generateAgeIdentity,
  tarListing,
  tarMember,
  type AgeIdentity,
} from '../helpers/age.js';

// Bytes that stand for a tenant's content: they must reach the archive,
// and must never be readable on disk.
const CONTENT_MARKER = 'PLAINTEXT-MEMBER-EMAIL-marker@tenant.test';
const ANALYTICS_MARKER = 'PLAINTEXT-ANALYTICS-ROW-marker';

interface Recording {
  statusReads: string[];
  drainSetCalls: string[];
  drainClearCalls: string[];
  containerStarted: boolean;
  containerStopped: boolean;
  exportCalls: string[];
  auditEntries: ExportAuditEntry[];
}

function fakeDeps(overrides: {
  supportStatus?: string | null;
  flagIsSet?: boolean;
  containerFails?: boolean;
  probeHealthy?: boolean;
  exportFails?: boolean;
  ageCommand?: string;
}): { deps: ExportRunnerDeps; recording: Recording } {
  const recording: Recording = {
    statusReads: [],
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
      return {
        filename: 'ghost.json',
        contentType: 'application/json',
        body: Buffer.from(`{"members":[{"email":"${CONTENT_MARKER}"}]}`),
      };
    },
    async fetchPostAnalytics() {
      recording.exportCalls.push('post_analytics');
      return {
        filename: 'ghost.analytics.csv',
        contentType: 'text/csv',
        body: Buffer.from(`post,visits\n${ANALYTICS_MARKER},2\n`),
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
    supportAccount: {
      async readStatus(identity) {
        recording.statusReads.push(identity);
        return overrides.supportStatus === undefined ? 'active' : overrides.supportStatus;
      },
    },
    containerRunner,
    probe,
    exportClient,
    auditLog,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    healthTimeoutMs: 200,
    healthPollIntervalMs: 10,
    ...(overrides.ageCommand ? { ageCommand: overrides.ageCommand } : {}),
  };

  return { deps, recording };
}

function expectNothingStarted(recording: Recording): void {
  expect(recording.drainSetCalls).toEqual([]);
  expect(recording.containerStarted).toBe(false);
  expect(recording.exportCalls).toEqual([]);
  expect(recording.auditEntries).toEqual([]);
}

describe('runExport', () => {
  let keyDir: string;
  let identity: AgeIdentity;
  let destDir: string;

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'export-bundler-run-key-'));
    identity = generateAgeIdentity(keyDir);
  });

  afterAll(async () => {
    await rm(keyDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    destDir = await mkdtemp(join(tmpdir(), 'export-bundler-run-test-'));
  });

  afterEach(async () => {
    await rm(destDir, { recursive: true, force: true });
  });

  const grant: SupportGrant = { lane: 'consented', reference: 'staff-log 2026-01-01T00:00Z' };

  function request(overrides: Partial<ExportRequest> = {}): ExportRequest {
    return {
      tenantId: 'tenant-1',
      requestedBy: 'rob@branchleft.co.uk',
      deliveredTo: 'rob@branchleft.co.uk',
      colourId: 'tenant-1-export-1',
      destDir,
      grant,
      supportIdentity: 'support@tenant-1.test',
      ageRecipient: identity.recipient,
      ...overrides,
    };
  }

  it('runs the full lifecycle: checks the grant, drains, starts, exports both files, encrypts, audits, stops', async () => {
    const { deps, recording } = fakeDeps({});
    const result = await runExport(deps, request());

    expect(recording.statusReads).toEqual(['support@tenant-1.test']);
    expect(recording.drainSetCalls).toEqual(['tenant-1-export-1']);
    expect(recording.containerStarted).toBe(true);
    expect(recording.exportCalls.sort()).toEqual(['content_and_settings', 'post_analytics']);
    expect(recording.containerStopped).toBe(true);
    expect(recording.drainClearCalls).toEqual(['tenant-1-export-1']);
    expect(result.manifest.included.map((e) => e.name).sort()).toEqual([
      'content_and_settings',
      'post_analytics',
    ]);
    expect((await readdir(destDir)).sort()).toEqual([
      'tenant-1-export-2026-01-01T000000000Z.manifest.json',
      'tenant-1-export-2026-01-01T000000000Z.tar.age',
    ]);
  });

  it('records the grant it ran under and the recipient fingerprint in the audit entry', async () => {
    const { deps, recording } = fakeDeps({});
    await runExport(
      deps,
      request({ grant: { lane: 'incident', reference: 'incident request 7' } })
    );
    expect(recording.auditEntries).toEqual([
      {
        tenantId: 'tenant-1',
        requestedBy: 'rob@branchleft.co.uk',
        occurredAt: '2026-01-01T00:00:00.000Z',
        contents: ['content_and_settings', 'post_analytics'],
        deliveredTo: 'rob@branchleft.co.uk',
        grant: { lane: 'incident', reference: 'incident request 7' },
        encryptedTo: recipientFingerprint(identity.recipient),
      },
    ]);
  });

  it("the archive decrypts, with the tenant's identity, to both exports and the manifest", async () => {
    const { deps } = fakeDeps({});
    const result = await runExport(deps, request());
    const tar = decryptAge(result.archivePath, identity.identityPath);
    expect(tarListing(tar)).toEqual([
      'content_and_settings.json',
      'post_analytics.csv',
      'manifest.json',
    ]);
    expect(tarMember(tar, 'content_and_settings.json').toString('utf8')).toContain(CONTENT_MARKER);
    expect(tarMember(tar, 'post_analytics.csv').toString('utf8')).toContain(ANALYTICS_MARKER);
    expect(JSON.parse(tarMember(tar, 'manifest.json').toString('utf8'))).toEqual(result.manifest);
  });

  it('the manifest, inside the archive and beside it, states the archive is age-encrypted and to which recipient fingerprint', async () => {
    const { deps } = fakeDeps({});
    const result = await runExport(deps, request());
    const expected = {
      encrypted: true,
      format: 'age',
      recipient: identity.recipient,
      recipientFingerprint: recipientFingerprint(identity.recipient),
    };
    expect(result.manifest.encryption).toEqual(expected);
    const sidecar = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(sidecar).toEqual(result.manifest);
    expect(sidecar.encryption).toEqual(expected);
  });

  it("PLAINTEXT NEVER ON DISK: no file the run leaves, in the destination or the temp directory, holds the tenant's content", async () => {
    const scratchTmp = await mkdtemp(join(tmpdir(), 'export-bundler-run-tmpdir-'));
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = scratchTmp;
    try {
      const { deps } = fakeDeps({});
      const result = await runExport(deps, request());

      // The markers did reach the archive, so their absence below means
      // "encrypted", not "never exported".
      const tar = decryptAge(result.archivePath, identity.identityPath);
      expect(tar.includes(Buffer.from(CONTENT_MARKER))).toBe(true);
      expect(tar.includes(Buffer.from(ANALYTICS_MARKER))).toBe(true);

      expect(await filesContaining(destDir, CONTENT_MARKER)).toEqual([]);
      expect(await filesContaining(destDir, ANALYTICS_MARKER)).toEqual([]);
      expect(await filesUnder(scratchTmp)).toEqual([]);
      expect((await readFile(result.archivePath)).subarray(0, 21).toString('ascii')).toBe(
        'age-encryption.org/v1'
      );
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      await rm(scratchTmp, { recursive: true, force: true });
    }
  });

  it.each([
    ['no lane', { lane: undefined as unknown as SupportGrant['lane'], reference: 'x' }],
    ['an unknown lane', { lane: 'automated' as SupportGrant['lane'], reference: 'x' }],
    ['an empty reference', { lane: 'consented' as const, reference: '' }],
  ])(
    'refuses -- NoSupportGrantError -- with %s, before reading anything or starting anything',
    async (_label, badGrant) => {
      const { deps, recording } = fakeDeps({});
      await expect(runExport(deps, request({ grant: badGrant }))).rejects.toThrow(
        NoSupportGrantError
      );
      expect(recording.statusReads).toEqual([]);
      expectNothingStarted(recording);
      expect(await readdir(destDir)).toEqual([]);
    }
  );

  it.each([['inactive'], ['locked'], [null]])(
    'refuses -- SupportAccountNotActiveError -- when the support account reads %j, and never sets the drain flag, starts the colour, exports or audits',
    async (status) => {
      const { deps, recording } = fakeDeps({ supportStatus: status });
      await expect(runExport(deps, request())).rejects.toThrow(SupportAccountNotActiveError);
      expect(recording.statusReads).toEqual(['support@tenant-1.test']);
      expectNothingStarted(recording);
      expect(recording.containerStopped).toBe(false);
      expect(await readdir(destDir)).toEqual([]);
    }
  );

  it('refuses a malformed age recipient before anything is started', async () => {
    const { deps, recording } = fakeDeps({});
    await expect(runExport(deps, request({ ageRecipient: 'age1nope' }))).rejects.toThrow(
      InvalidAgeRecipientError
    );
    expectNothingStarted(recording);
  });

  it('refuses -- UndrainedColourError -- when the colour reads as undrained, and never starts the container or calls the exports', async () => {
    const { deps, recording } = fakeDeps({ flagIsSet: false });
    await expect(runExport(deps, request())).rejects.toThrow(UndrainedColourError);
    expect(recording.containerStarted).toBe(false);
    expect(recording.exportCalls).toEqual([]);
    expect(recording.auditEntries).toEqual([]);
    expect(await readdir(destDir)).toEqual([]);
  });

  it('when encryption fails: the colour is still stopped, nothing is audited and no file is left', async () => {
    const { deps, recording } = fakeDeps({ ageCommand: join(destDir, 'no-such-age') });
    await expect(runExport(deps, request())).rejects.toThrow(AgeEncryptionError);
    expect(recording.containerStopped).toBe(true);
    expect(recording.drainClearCalls).toEqual(['tenant-1-export-1']);
    expect(recording.auditEntries).toEqual([]);
    expect(await readdir(destDir)).toEqual([]);
  });

  it('stops the container even when Ghost never becomes healthy', async () => {
    const { deps, recording } = fakeDeps({ probeHealthy: false });
    await expect(runExport(deps, request())).rejects.toThrow(GhostNeverBecameHealthyError);
    expect(recording.containerStopped).toBe(true);
    expect(recording.drainClearCalls).toEqual(['tenant-1-export-1']);
    expect(recording.auditEntries).toEqual([]);
  });

  it('stops the container even when the export calls fail', async () => {
    const { deps, recording } = fakeDeps({ exportFails: true });
    await expect(runExport(deps, request())).rejects.toThrow('export sabotage failure');
    expect(recording.containerStopped).toBe(true);
    expect(recording.auditEntries).toEqual([]);
  });

  it('succeeds with a request that carries no subscription or liveness field at all -- structurally, there is nothing to gate on', async () => {
    const { deps } = fakeDeps({});
    const req = request();
    expect('subscriptionActive' in req).toBe(false);
    expect('liveColourHealthy' in req).toBe(false);
    await expect(runExport(deps, req)).resolves.toBeDefined();
  });
});
