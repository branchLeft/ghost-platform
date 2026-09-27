import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileAuditLog } from '../../src/auditLog.js';

describe('createFileAuditLog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-audit-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records who asked, when, what the archive contained, and where it was delivered', async () => {
    const path = join(dir, 'audit.jsonl');
    const log = createFileAuditLog(path);

    await log.record({
      tenantId: 'tenant-1',
      requestedBy: 'rob@branchleft.co.uk',
      occurredAt: '2026-01-01T00:00:00.000Z',
      contents: ['content_and_settings', 'post_analytics'],
      deliveredTo: 'rob@branchleft.co.uk',
    });

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      tenantId: 'tenant-1',
      requestedBy: 'rob@branchleft.co.uk',
      occurredAt: '2026-01-01T00:00:00.000Z',
      contents: ['content_and_settings', 'post_analytics'],
      deliveredTo: 'rob@branchleft.co.uk',
    });
  });

  it('appends rather than overwriting -- one entry per export, the whole history stays', async () => {
    const path = join(dir, 'audit.jsonl');
    const log = createFileAuditLog(path);
    const entry = (tenantId: string) => ({
      tenantId,
      requestedBy: 'a',
      occurredAt: '2026-01-01T00:00:00.000Z',
      contents: [],
      deliveredTo: 'a',
    });

    await log.record(entry('tenant-1'));
    await log.record(entry('tenant-2'));

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).tenantId).toBe('tenant-1');
    expect(JSON.parse(lines[1]!).tenantId).toBe('tenant-2');
  });

  it('is never world- or group-readable, even if an earlier run left it looser', async () => {
    const path = join(dir, 'audit.jsonl');
    const log = createFileAuditLog(path);
    await log.record({
      tenantId: 'tenant-1',
      requestedBy: 'a',
      occurredAt: '2026-01-01T00:00:00.000Z',
      contents: [],
      deliveredTo: 'a',
    });
    await chmod(path, 0o644);

    await log.record({
      tenantId: 'tenant-2',
      requestedBy: 'a',
      occurredAt: '2026-01-01T00:00:00.000Z',
      contents: [],
      deliveredTo: 'a',
    });

    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
  });
});
