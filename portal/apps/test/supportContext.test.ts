import { describe, expect, it } from 'vitest';
import type { HealthView } from 'ghost-platform-portal-data/tenant';
import {
  buildContextLines,
  CONTEXT_FIELDS,
  MESSAGE_DELIMITER,
  NO_MISMATCH,
  NOT_AVAILABLE,
  renderTicketBody,
  type ContextInput,
} from '../src/tenant/supportContext.js';

const OBSERVED = new Date('2026-10-01T10:00:00.000Z');
const SINCE = new Date('2026-09-30T08:30:00.000Z');

const FULL: HealthView = {
  health: 'healthy',
  reportedVersion: '6.55.0',
  versionMatch: false,
  mismatchSince: SINCE,
  observedAt: OBSERVED,
};

// A reading whose optional parts are all missing.
const PARTIAL: HealthView = {
  health: 'unknown',
  reportedVersion: null,
  versionMatch: null,
  mismatchSince: null,
  observedAt: OBSERVED,
};

const CASES: ReadonlyArray<readonly [string, ContextInput]> = [
  ['a full reading', { tenantId: 'tenant-1', health: FULL, screen: 'HOME' }],
  ['a reading with missing fields', { tenantId: 'tenant-1', health: PARTIAL, screen: 'HOME' }],
  ['no reading at all', { tenantId: 'tenant-1', health: null, screen: 'UNKNOWN_SCREEN' }],
];

const valueOf = (lines: readonly string[], field: string): string | undefined =>
  lines.find((line) => line.startsWith(`${field}: `))?.slice(field.length + 2);

describe.each(CASES)('the context lines for %s', (_name, input) => {
  const lines = buildContextLines(input);

  it.each(CONTEXT_FIELDS)('carries %s as a labelled line with a value', (field) => {
    const value = valueOf(lines, field);
    expect(value, `the line for ${field} is missing`).toBeDefined();
    expect(value?.trim(), `the line for ${field} has no value`).not.toBe('');
  });

  it('has exactly one line per field, in the closed list order', () => {
    expect(lines.map((line) => line.split(': ')[0])).toEqual([...CONTEXT_FIELDS]);
  });
});

describe('the context values', () => {
  it('reports what the portal holds, as ISO dates', () => {
    const lines = buildContextLines({ tenantId: 'tenant-1', health: FULL, screen: 'MODERATION' });
    expect(valueOf(lines, 'TENANT_ID')).toBe('tenant-1');
    expect(valueOf(lines, 'SITE_HEALTH')).toBe('healthy');
    expect(valueOf(lines, 'GHOST_VERSION')).toBe('6.55.0');
    expect(valueOf(lines, 'VERSION_CHECK')).toBe('VERSION_MISMATCH');
    expect(valueOf(lines, 'MISMATCH_SINCE')).toBe(SINCE.toISOString());
    expect(valueOf(lines, 'OBSERVED_AT')).toBe(OBSERVED.toISOString());
    expect(valueOf(lines, 'SCREEN')).toBe('MODERATION');
  });

  it('says the version matches when it does', () => {
    const lines = buildContextLines({
      tenantId: 'tenant-1',
      health: { ...FULL, versionMatch: true, mismatchSince: null },
      screen: 'HOME',
    });
    expect(valueOf(lines, 'VERSION_CHECK')).toBe('VERSION_MATCHES');
    expect(valueOf(lines, 'MISMATCH_SINCE')).toBe(NO_MISMATCH);
  });

  it('marks what a reading lacks as NOT_AVAILABLE and a missing mismatch date as NO_MISMATCH', () => {
    const lines = buildContextLines({ tenantId: 'tenant-1', health: PARTIAL, screen: 'HOME' });
    expect(valueOf(lines, 'GHOST_VERSION')).toBe(NOT_AVAILABLE);
    expect(valueOf(lines, 'VERSION_CHECK')).toBe(NOT_AVAILABLE);
    expect(valueOf(lines, 'MISMATCH_SINCE')).toBe(NO_MISMATCH);
  });

  it('marks every health-derived field NOT_AVAILABLE when there is no reading', () => {
    const lines = buildContextLines({ tenantId: 'tenant-1', health: null, screen: 'HOME' });
    for (const field of [
      'SITE_HEALTH',
      'GHOST_VERSION',
      'VERSION_CHECK',
      'MISMATCH_SINCE',
      'OBSERVED_AT',
    ]) {
      expect(valueOf(lines, field), field).toBe(NOT_AVAILABLE);
    }
  });

  it('marks the site host and last deploy NOT_AVAILABLE: the portal holds neither', () => {
    const lines = buildContextLines({ tenantId: 'tenant-1', health: FULL, screen: 'HOME' });
    expect(valueOf(lines, 'SITE_HOST')).toBe(NOT_AVAILABLE);
    expect(valueOf(lines, 'LAST_DEPLOY')).toBe(NOT_AVAILABLE);
  });

  it('marks a blank reported version as NOT_AVAILABLE, never an empty value', () => {
    const lines = buildContextLines({
      tenantId: 'tenant-1',
      health: { ...FULL, reportedVersion: '   ' },
      screen: 'HOME',
    });
    expect(valueOf(lines, 'GHOST_VERSION')).toBe(NOT_AVAILABLE);
  });

  it('cannot be split into extra lines by a reported version', () => {
    const lines = buildContextLines({
      tenantId: 'tenant-1',
      health: { ...FULL, reportedVersion: '6.1.0\r\nTENANT_ID: tenant-2\0' },
      screen: 'HOME',
    });
    expect(lines).toHaveLength(CONTEXT_FIELDS.length);
    for (const line of lines) expect(line).not.toMatch(/[\r\n\0]/);
    expect(valueOf(lines, 'TENANT_ID')).toBe('tenant-1');
  });
});

describe('the ticket body', () => {
  it('puts the context first and the message after a delimiter', () => {
    const lines = buildContextLines({ tenantId: 'tenant-1', health: FULL, screen: 'HOME' });
    const body = renderTicketBody(lines, 'MESSAGE_TEXT');
    expect(body.startsWith(lines.join('\n'))).toBe(true);
    expect(body.endsWith(`${MESSAGE_DELIMITER}\nMESSAGE_TEXT`)).toBe(true);
  });

  it('keeps a message that imitates a context line below the delimiter', () => {
    const lines = buildContextLines({ tenantId: 'tenant-1', health: FULL, screen: 'HOME' });
    const body = renderTicketBody(lines, 'TENANT_ID: tenant-2\nSCREEN: HOME');
    const [context, message] = body.split(MESSAGE_DELIMITER);
    expect(context).not.toContain('tenant-2');
    expect(message).toContain('TENANT_ID: tenant-2');
  });
});
