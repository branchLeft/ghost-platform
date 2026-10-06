import { createHash } from 'node:crypto';
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
import { verifyMediaLink } from '../../src/mediaLinks.js';
import { UndrainedColourError } from '../../src/drainGate.js';
import type { DrainFlag } from '../../src/drainFlag.js';
import type { ColourAttachments, ContainerRunner } from '../../src/containerRunner.js';
import {
  LiveDatabaseTargetError,
  type DatabaseTarget,
  type ScratchCopy,
  type ScratchDatabase,
} from '../../src/scratchDatabase.js';
import type { Collection, GhostExportClient } from '../../src/ghostExportClient.js';
import type { MediaProbe } from '../../src/mediaManifest.js';
import type { MediaConfig } from '../../src/extensions.js';
import type { GhostProbe } from '../../src/ghostProbe.js';
import { AuditWriteError, type AuditRecorder, type ExportAuditEntry } from '../../src/auditLog.js';
import {
  AgeEncryptionError,
  InvalidAgeRecipientError,
  recipientFingerprint,
} from '../../src/ageEncryption.js';
import {
  NoSupportGrantError,
  NotTheSupportAccountError,
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

const MEDIA_BASE = 'https://media.test/opaque-t1';
const MEDIA: MediaConfig = {
  redeemable: true,
  baseUrl: MEDIA_BASE,
  signer: { baseUrl: 'https://export.test', ttlSeconds: 3600, secret: Buffer.alloc(32, 7) },
};
// One object of this tenant's, and one under another tenant's prefix on the same shard.
const CONTENT_JSON = `{"members":[{"email":"${'PLAINTEXT-MEMBER-EMAIL-marker@tenant.test'}"}],"posts":[{"feature_image":"${MEDIA_BASE}/2026/own.png"},{"feature_image":"https://media.test/opaque-t2/2026/other.png"}]}`;
const MEMBERS: Collection = {
  total: 2,
  items: [
    { id: 'm1', email: 'one@tenant.test', subscriptions: [{ id: 's1', status: 'active' }] },
    { id: 'm2', email: 'two@tenant.test', subscriptions: [] },
  ],
};
const COMMENTS: Collection = {
  total: 2,
  items: [
    { id: 'c1', status: 'published', html: '<p>one</p>', count: { reports: 0 } },
    { id: 'c2', status: 'hidden', html: '<p>two</p>', count: { reports: 1 } },
  ],
};

const LIVE_ENV = {
  url: 'https://tenant-1.example',
  database__client: 'mysql',
  database__connection__host: '10.0.0.5',
  database__connection__port: '3306',
  database__connection__user: 'ghost_tenant1',
  database__connection__password: 'synthetic-live-password',
  database__connection__database: 'ghost_tenant1',
  mail__transport: 'stub',
};
const LIVE_DATABASE: DatabaseTarget = {
  kind: 'mysql',
  host: '10.0.0.5',
  port: 3306,
  database: 'ghost_tenant1',
};
const SCRATCH_COPY: ScratchCopy = {
  target: { kind: 'mysql', host: 'tenant-1-export-1-db', port: 3306, database: 'ghost_tenant1' },
  colourDatabaseEnv: {
    database__client: 'mysql',
    database__connection__host: 'tenant-1-export-1-db',
    database__connection__port: '3306',
    database__connection__user: 'root',
    database__connection__password: 'scratch-password',
    database__connection__database: 'ghost_tenant1',
  },
  colourVolumes: [],
  network: 'tenant-1-export-1-net',
};

interface Recording {
  accountReads: string[];
  drainSetCalls: string[];
  drainClearCalls: string[];
  scratchPrepared: boolean;
  scratchDestroyed: boolean;
  containerStarted: boolean;
  containerStopped: boolean;
  colourEnv: Readonly<Record<string, string>> | undefined;
  colourAttach: ColourAttachments | undefined;
  exportCalls: string[];
  auditEntries: ExportAuditEntry[];
  /** The order teardown steps ran in. */
  teardown: string[];
}

function fakeDeps(overrides: {
  supportStatus?: string | null;
  supportRoles?: readonly string[];
  auditFails?: boolean;
  flagIsSet?: boolean;
  containerFails?: boolean;
  probeHealthy?: boolean;
  exportFails?: boolean;
  ageCommand?: string;
  scratchFails?: boolean;
  /** What the scratch copy hands back; the default points at the copy. */
  copy?: ScratchCopy;
  /** What Docker reports for the running colour; the default is what it was given. */
  reportedColourEnv?: Readonly<Record<string, string>>;
  members?: () => Promise<Collection>;
  comments?: () => Promise<Collection>;
  mediaExists?: boolean;
}): { deps: ExportRunnerDeps; recording: Recording } {
  const recording: Recording = {
    accountReads: [],
    drainSetCalls: [],
    drainClearCalls: [],
    scratchPrepared: false,
    scratchDestroyed: false,
    containerStarted: false,
    containerStopped: false,
    colourEnv: undefined,
    colourAttach: undefined,
    exportCalls: [],
    auditEntries: [],
    teardown: [],
  };

  const flag: DrainFlag = { isSet: () => overrides.flagIsSet ?? true };

  const scratch: ScratchDatabase = {
    async prepare() {
      recording.scratchPrepared = true;
      if (overrides.scratchFails) throw new Error('scratch sabotage failure');
      return overrides.copy ?? SCRATCH_COPY;
    },
    async destroy() {
      recording.scratchDestroyed = true;
      recording.teardown.push('scratch');
    },
  };

  const containerRunner: ContainerRunner = {
    async start(env, attach) {
      recording.containerStarted = true;
      recording.colourEnv = env;
      recording.colourAttach = attach;
      if (overrides.containerFails) throw new Error('container sabotage failure');
      return { baseUrl: 'http://127.0.0.1:1' };
    },
    async readEnv() {
      return overrides.reportedColourEnv ?? recording.colourEnv ?? {};
    },
    async stop() {
      recording.containerStopped = true;
      recording.teardown.push('colour');
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
        body: Buffer.from(CONTENT_JSON),
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
    async fetchMembersCsv() {
      recording.exportCalls.push('members_csv');
      return {
        filename: 'members.csv',
        contentType: 'text/csv',
        body: Buffer.from('id,email\nm1,one@tenant.test\n'),
      };
    },
    async fetchMembers() {
      recording.exportCalls.push('members');
      return (overrides.members ?? (async () => MEMBERS))();
    },
    async fetchComments() {
      recording.exportCalls.push('comments');
      return (overrides.comments ?? (async () => COMMENTS))();
    },
    async fetchCommentReports() {
      recording.exportCalls.push('comment_reports');
      return { total: 1, items: [{ id: 'r1', member_id: 'm2' }] };
    },
  };
  const mediaProbe: MediaProbe = {
    async head() {
      return { exists: overrides.mediaExists ?? true, bytes: 10 };
    },
  };

  const auditLog: AuditRecorder = {
    async record(entry) {
      if (overrides.auditFails) throw new AuditWriteError('ENOSPC');
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
        recording.teardown.push('drain flag');
      },
    },
    readDrainFlag: () => flag,
    supportAccount: {
      async readPreflight(identity) {
        recording.accountReads.push(identity);
        const status = overrides.supportStatus === undefined ? 'active' : overrides.supportStatus;
        if (status === null) return { account: null };
        return { account: { status, roles: overrides.supportRoles ?? ['Administrator'] } };
      },
    },
    scratch,
    containerRunner,
    probe,
    exportClient,
    mediaProbe,
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
  expect(recording.scratchPrepared).toBe(false);
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
      colourBaseEnv: LIVE_ENV,
      liveDatabase: LIVE_DATABASE,
      media: MEDIA,
      ...overrides,
    };
  }

  it("boots the colour against the run's scratch copy, never the live database", async () => {
    const { deps, recording } = fakeDeps({});
    await runExport(deps, request());
    expect(recording.colourEnv).toEqual({
      url: 'https://tenant-1.example',
      mail__transport: 'stub',
      ...SCRATCH_COPY.colourDatabaseEnv,
    });
    expect(Object.values(recording.colourEnv ?? {})).not.toContain('synthetic-live-password');
    expect(Object.values(recording.colourEnv ?? {})).not.toContain('10.0.0.5');
    expect(recording.colourAttach).toEqual({ network: 'tenant-1-export-1-net', volumes: [] });
  });

  it('REFUSES -- LiveDatabaseTargetError -- a colour that would be pointed at the live database, before it starts', async () => {
    const pointedAtLive: ScratchCopy = {
      ...SCRATCH_COPY,
      colourDatabaseEnv: {
        database__client: 'mysql',
        database__connection__host: '10.0.0.5',
        database__connection__port: '3306',
        database__connection__database: 'ghost_tenant1',
      },
    };
    const { deps, recording } = fakeDeps({ copy: pointedAtLive });
    await expect(runExport(deps, request())).rejects.toThrow(LiveDatabaseTargetError);
    expect(recording.containerStarted).toBe(false);
    expect(recording.exportCalls).toEqual([]);
    expect(recording.scratchDestroyed).toBe(true);
    expect(recording.drainClearCalls).toEqual(['tenant-1-export-1']);
  });

  it('REFUSES -- LiveDatabaseTargetError -- when Docker reports the running colour on the live database, before any export call', async () => {
    const { deps, recording } = fakeDeps({ reportedColourEnv: LIVE_ENV });
    await expect(runExport(deps, request())).rejects.toThrow(LiveDatabaseTargetError);
    expect(recording.containerStarted).toBe(true);
    expect(recording.exportCalls).toEqual([]);
    expect(recording.teardown).toEqual(['colour', 'scratch', 'drain flag']);
  });

  it('tears down the colour, then the copy, then the drain flag -- on success', async () => {
    const { deps, recording } = fakeDeps({});
    await runExport(deps, request());
    expect(recording.teardown).toEqual(['colour', 'scratch', 'drain flag']);
  });

  it.each([
    [
      'the copy cannot be made',
      { scratchFails: true },
      'scratch sabotage failure',
      ['scratch', 'drain flag'],
    ],
    [
      'the colour cannot start',
      { containerFails: true },
      'container sabotage failure',
      ['scratch', 'drain flag'],
    ],
    [
      'an export call fails',
      { exportFails: true },
      'export sabotage failure',
      ['colour', 'scratch', 'drain flag'],
    ],
  ])(
    'removes the copy and clears the drain flag when %s',
    async (_label, opts, message, teardown) => {
      const { deps, recording } = fakeDeps(opts);
      await expect(runExport(deps, request())).rejects.toThrow(message);
      expect(recording.teardown).toEqual(teardown);
      expect(recording.auditEntries).toEqual([]);
    }
  );

  it('runs the full lifecycle: checks the grant, drains, starts, exports both files, encrypts, audits, stops', async () => {
    const { deps, recording } = fakeDeps({});
    const result = await runExport(deps, request());

    expect(recording.accountReads).toEqual(['support@tenant-1.test']);
    expect(recording.drainSetCalls).toEqual(['tenant-1-export-1']);
    expect(recording.containerStarted).toBe(true);
    expect(recording.exportCalls.sort()).toEqual([
      'comment_reports',
      'comments',
      'content_and_settings',
      'members',
      'members_csv',
      'post_analytics',
    ]);
    expect(recording.containerStopped).toBe(true);
    expect(recording.drainClearCalls).toEqual(['tenant-1-export-1']);
    expect(result.manifest.included.map((e) => e.name).sort()).toEqual([
      'comments',
      'content_and_settings',
      'media_links',
      'members',
      'members_csv',
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
        contents: [
          'content_and_settings',
          'post_analytics',
          'media_links',
          'members',
          'members_csv',
          'comments',
        ],
        complete: true,
        deliveredTo: 'rob@branchleft.co.uk',
        grant: { lane: 'incident', reference: 'incident request 7' },
        supportIdentity: 'support@tenant-1.test',
        encryptedTo: recipientFingerprint(identity.recipient),
        archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
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
      'media_links.json',
      'members.json',
      'members.csv',
      'comments.json',
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

      // The on-disk scan comes first, so it is what fails if plaintext
      // lands anywhere.
      expect(await filesContaining(destDir, CONTENT_MARKER)).toEqual([]);
      expect(await filesContaining(destDir, ANALYTICS_MARKER)).toEqual([]);
      expect(await filesUnder(scratchTmp)).toEqual([]);
      expect((await readFile(result.archivePath)).subarray(0, 21).toString('ascii')).toBe(
        'age-encryption.org/v1'
      );

      // The markers did reach the archive, so their absence above means
      // "encrypted", not "never exported".
      const tar = decryptAge(result.archivePath, identity.identityPath);
      expect(tar.includes(Buffer.from(CONTENT_MARKER))).toBe(true);
      expect(tar.includes(Buffer.from(ANALYTICS_MARKER))).toBe(true);
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
      expect(recording.accountReads).toEqual([]);
      expectNothingStarted(recording);
      expect(await readdir(destDir)).toEqual([]);
    }
  );

  it.each([['inactive'], ['locked'], [null]])(
    'refuses -- SupportAccountNotActiveError -- when the support account reads %j, and never sets the drain flag, starts the colour, exports or audits',
    async (status) => {
      const { deps, recording } = fakeDeps({ supportStatus: status });
      await expect(runExport(deps, request())).rejects.toThrow(SupportAccountNotActiveError);
      expect(recording.accountReads).toEqual(['support@tenant-1.test']);
      expectNothingStarted(recording);
      expect(recording.containerStopped).toBe(false);
      expect(await readdir(destDir)).toEqual([]);
    }
  );

  it.each([[['Owner']], [['Owner', 'Administrator']], [['Editor']], [[]]])(
    'refuses -- NotTheSupportAccountError -- an active account with roles %j, before anything is started',
    async (roles) => {
      const { deps, recording } = fakeDeps({ supportStatus: 'active', supportRoles: roles });
      await expect(
        runExport(deps, request({ supportIdentity: 'owner@tenant-1.test' }))
      ).rejects.toThrow(NotTheSupportAccountError);
      expect(recording.accountReads).toEqual(['owner@tenant-1.test']);
      expectNothingStarted(recording);
      expect(await readdir(destDir)).toEqual([]);
    }
  );

  it("the audit record's archiveSha256 is the SHA-256 of the archive file on disk", async () => {
    const { deps, recording } = fakeDeps({});
    const result = await runExport(deps, request());
    const digest = createHash('sha256')
      .update(await readFile(result.archivePath))
      .digest('hex');
    expect(result.archiveSha256).toBe(digest);
    expect(recording.auditEntries[0]?.archiveSha256).toBe(digest);
  });

  it('when the audit write fails: the archive and manifest are removed, the error is raised, and the colour is stopped', async () => {
    const { deps, recording } = fakeDeps({ auditFails: true });
    await expect(runExport(deps, request())).rejects.toThrow(AuditWriteError);
    expect(await readdir(destDir)).toEqual([]);
    expect(recording.containerStopped).toBe(true);
    expect(recording.drainClearCalls).toEqual(['tenant-1-export-1']);
  });

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

  describe('export completeness', () => {
    const FIXED_NOW = Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000);

    async function archiveOf(result: Awaited<ReturnType<typeof runExport>>) {
      const tar = decryptAge(result.archivePath, identity.identityPath);
      const part = (name: string) => JSON.parse(tarMember(tar, name).toString('utf8'));
      return { tar, part };
    }

    it('names all three extensions in the manifest, each present, and claims completeness', async () => {
      const { deps } = fakeDeps({});
      const result = await runExport(deps, request());
      expect(result.manifest.complete).toBe(true);
      expect(
        result.manifest.extensions.map((e) => [e.name, e.status, e.expected, e.present])
      ).toEqual([
        ['media', 'complete', 1, 1],
        ['members_and_subscriptions', 'complete', 2, 2],
        ['comments', 'complete', 2, 2],
      ]);
      const { part } = await archiveOf(result);
      expect(part('members.json').members).toHaveLength(2);
      expect(part('comments.json').comments).toHaveLength(2);
      expect(part('media_links.json').links).toHaveLength(1);
    });

    it("carries each comment's moderation state with its text", async () => {
      const { deps } = fakeDeps({});
      const { part } = await archiveOf(await runExport(deps, request()));
      const comments = part('comments.json').comments as Record<string, any>[];
      expect(comments.map((c) => [c.html, c.moderation.status])).toEqual([
        ['<p>one</p>', 'published'],
        ['<p>two</p>', 'hidden'],
      ]);
      expect(comments[1]?.moderation.reports).toEqual([{ id: 'r1', member_id: 'm2' }]);
    });

    it("CROSS-TENANT: signs a link only for this tenant, and never for an object under another tenant's prefix", async () => {
      const { deps } = fakeDeps({});
      const { part } = await archiveOf(await runExport(deps, request()));
      const links = part('media_links.json');
      expect(links.links.map((l: { key: string }) => l.key)).toEqual(['2026/own.png']);
      expect(links.refused).toEqual([
        {
          reference: 'https://media.test/opaque-t2/2026/other.png',
          reason: 'outside-tenant-prefix',
        },
      ]);
      const everyLink = links.links.map((l: { url: string }) => l.url).join(' ');
      expect(everyLink).not.toContain('opaque-t2');
      expect(everyLink).not.toContain('other.png');
      for (const link of links.links as { url: string }[]) {
        const verified = verifyMediaLink(MEDIA.signer.secret, link.url, FIXED_NOW, 'tenant-1');
        expect(verified.tenantId).toBe('tenant-1');
        expect(() => verifyMediaLink(MEDIA.signer.secret, link.url, FIXED_NOW, 'tenant-2')).toThrow(
          /another tenant/
        );
      }
    });

    it('the links in the archive EXPIRE at the lifetime asked for', async () => {
      const { deps } = fakeDeps({});
      const { part } = await archiveOf(await runExport(deps, request()));
      const [link] = part('media_links.json').links as { url: string; expiresAt: number }[];
      expect(link?.expiresAt).toBe(FIXED_NOW + 3600);
      expect(() => verifyMediaLink(MEDIA.signer.secret, link!.url, FIXED_NOW + 3599)).not.toThrow();
      expect(() => verifyMediaLink(MEDIA.signer.secret, link!.url, FIXED_NOW + 3600)).toThrow(
        /expired/
      );
    });

    it('puts no link and no tenant content in the manifest that sits beside the archive', async () => {
      const { deps } = fakeDeps({});
      const result = await runExport(deps, request());
      const sidecar = await readFile(result.manifestPath, 'utf8');
      expect(sidecar).not.toMatch(/sig=|expires=|https?:\/\//);
      expect(sidecar).not.toContain('one@tenant.test');
      expect(sidecar).not.toContain('<p>');
    });

    it.each([
      [
        'members fetch',
        {
          members: async () => {
            throw new Error('members down');
          },
        },
        'members_and_subscriptions',
      ],
      [
        'comments fetch',
        {
          comments: async () => {
            throw new Error('comments down');
          },
        },
        'comments',
      ],
    ])(
      'a failed %s shows in the manifest and the audit record; the archive is not called complete',
      async (_l, over, name) => {
        const { deps, recording } = fakeDeps(over);
        const result = await runExport(deps, request());
        expect(result.manifest.complete).toBe(false);
        expect(result.manifest.extensions.find((e) => e.name === name)?.status).toBe('failed');
        expect(result.manifest.excluded[0]).toEqual({ name, reason: 'failed: Error' });
        expect(recording.auditEntries[0]?.complete).toBe(false);
        const sidecar = JSON.parse(await readFile(result.manifestPath, 'utf8'));
        expect(sidecar.complete).toBe(false);
      }
    );

    it('a short members read is partial, not complete', async () => {
      const { deps } = fakeDeps({
        members: async () => ({ total: 9, items: [{ id: 'm1', subscriptions: [] }] }),
      });
      const result = await runExport(deps, request());
      expect(result.manifest.complete).toBe(false);
      expect(result.manifest.excluded[0]?.reason).toBe('partial: read 1 members, Ghost counts 9');
    });

    it('a referenced object missing from storage makes the media extension partial', async () => {
      const { deps } = fakeDeps({ mediaExists: false });
      const result = await runExport(deps, request());
      expect(result.manifest.complete).toBe(false);
      expect(result.manifest.excluded[0]).toEqual({
        name: 'media',
        reason: 'partial: 1 referenced objects are not in storage',
      });
    });

    it('a tenant with no object-storage media gets the media gap named, and the rest still exported', async () => {
      const { deps } = fakeDeps({});
      const result = await runExport(deps, request({ media: { ...MEDIA, baseUrl: null } }));
      expect(result.manifest.complete).toBe(false);
      expect(result.manifest.extensions.map((e) => e.status)).toEqual([
        'failed',
        'complete',
        'complete',
      ]);
    });

    it('does not claim completeness while no route verifies the media links', async () => {
      const { deps } = fakeDeps({});
      const result = await runExport(deps, request({ media: { ...MEDIA, redeemable: false } }));
      expect(result.manifest.complete).toBe(false);
      expect(result.manifest.excluded[0]).toEqual({
        name: 'media',
        reason: 'partial: no route verifies these links yet',
      });
    });

    it("names what no archive can hold: Stripe's side, the portal moderation record, media bytes and analytics", async () => {
      const { deps } = fakeDeps({});
      const result = await runExport(deps, request());
      expect(result.manifest.excluded.map((g) => g.name)).toEqual([
        'analytics_beyond_post_csv',
        'stripe_billing_relationship',
        'portal_moderation_record',
        'deleted_comments',
        'media_bytes',
      ]);
    });
  });
});
