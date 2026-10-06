import { describe, expect, it } from 'vitest';
import { renderHealth } from '../src/shell/healthHtml.js';

const base = {
  health: 'healthy' as const,
  reportedVersion: '6.55.0',
  versionMatch: true,
  mismatchSince: null,
  observedAt: new Date('2026-10-01T10:00:00Z'),
};

describe('renderHealth', () => {
  it('says when there is no reading', () => {
    expect(renderHealth(null)).toContain('NO_READING');
  });

  it('shows health, version and a matching check', () => {
    const html = renderHealth(base);
    expect(html).toContain('HEALTHY');
    expect(html).toContain('6.55.0');
    expect(html).toContain('VERSION_MATCHES');
    expect(html).not.toContain('MISMATCH_SINCE');
  });

  it('dates a mismatch', () => {
    const html = renderHealth({
      ...base,
      versionMatch: false,
      mismatchSince: new Date('2026-09-30T08:00:00Z'),
    });
    expect(html).toContain('VERSION_MISMATCH');
    expect(html).toContain('2026-09-30');
  });

  it('says so when the version or the check is unknown', () => {
    const html = renderHealth({
      ...base,
      health: 'unknown',
      reportedVersion: null,
      versionMatch: null,
    });
    expect(html).toContain('UNKNOWN');
    expect(html).toContain('NO_VERSION');
    expect(html).toContain('MATCH_UNKNOWN');
  });

  it('escapes a version it was given', () => {
    expect(renderHealth({ ...base, reportedVersion: '<b>' })).toContain('&lt;b&gt;');
  });
});
