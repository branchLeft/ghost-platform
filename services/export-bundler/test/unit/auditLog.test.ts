import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditWriteError, createFileAuditLog, type ExportAuditEntry } from '../../src/auditLog.js';

function entry(tenantId: string, overrides: Partial<ExportAuditEntry> = {}): ExportAuditEntry {
  return {
    tenantId,
    requestedBy: 'a',
    occurredAt: '2026-01-01T00:00:00.000Z',
    contents: [],
    deliveredTo: 'a',
    grant: { lane: 'consented', reference: 'staff-log entry' },
    supportIdentity: 'support@tenant.test',
    encryptedTo: 'sha256:abc',
    archiveSha256: 'f'.repeat(64),
    ...overrides,
  };
}

describe('createFileAuditLog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-audit-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records who asked, when, what, where, the grant, the identity used, the recipient and the archive digest', async () => {
    const path = join(dir, 'audit.jsonl');
    const log = createFileAuditLog(path);
    const recorded = entry('tenant-1', {
      requestedBy: 'rob@branchleft.co.uk',
      contents: ['content_and_settings', 'post_analytics'],
      deliveredTo: 'rob@branchleft.co.uk',
      grant: { lane: 'incident', reference: 'incident request 42' },
    });

    await log.record(recorded);

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(recorded);
  });

  it('appends rather than overwriting -- one entry per export, the whole history stays', async () => {
    const path = join(dir, 'audit.jsonl');
    const log = createFileAuditLog(path);

    await log.record(entry('tenant-1'));
    await log.record(entry('tenant-2'));

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).tenantId).toBe('tenant-1');
    expect(JSON.parse(lines[1]!).tenantId).toBe('tenant-2');
  });

  it('keeps every line whole when many records land at once', async () => {
    const path = join(dir, 'audit.jsonl');
    const log = createFileAuditLog(path);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        log.record(entry(`tenant-${i}`, { requestedBy: 'x'.repeat(2000) }))
      )
    );
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(50);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('is never world- or group-readable, even if an earlier run left it looser', async () => {
    const path = join(dir, 'audit.jsonl');
    const log = createFileAuditLog(path);
    await log.record(entry('tenant-1'));
    await chmod(path, 0o644);

    await log.record(entry('tenant-2'));

    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('raises AuditWriteError when the record cannot be written', async () => {
    const path = join(dir, 'is-a-directory');
    await mkdir(path);
    await expect(createFileAuditLog(path).record(entry('tenant-1'))).rejects.toThrow(
      AuditWriteError
    );
  });
});
