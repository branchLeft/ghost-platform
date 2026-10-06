import { describe, expect, it } from 'vitest';
import { MalformedScrapeError, deriveReading, parseScrape } from '../src/reading.js';

const scrape = (drained: boolean, version?: string, match?: boolean): string =>
  [
    '# HELP drain_sidecar_drained x',
    '# TYPE drain_sidecar_drained gauge',
    `drain_sidecar_drained ${drained ? 1 : 0}`,
    ...(version === undefined
      ? []
      : [
          '# TYPE drain_sidecar_ghost_version_info gauge',
          `drain_sidecar_ghost_version_info{version="${version}"} 1`,
        ]),
    ...(match === undefined ? [] : [`drain_sidecar_version_match ${match ? 1 : 0}`]),
    '',
  ].join('\n');

describe('parseScrape', () => {
  it('reads the drain flag, version and match', () => {
    expect(parseScrape(scrape(false, '6.55.0', true))).toEqual({
      drained: false,
      reportedVersion: '6.55.0',
      versionMatch: true,
    });
  });

  it('reads a drained colour that carries no version', () => {
    expect(parseScrape(scrape(true))).toEqual({
      drained: true,
      reportedVersion: null,
      versionMatch: null,
    });
  });

  it('reads a mismatch', () => {
    expect(parseScrape(scrape(false, '6.54.0', false)).versionMatch).toBe(false);
  });

  it('refuses a scrape with no drain flag', () => {
    expect(() => parseScrape('drain_sidecar_version_match 1\n')).toThrow(MalformedScrapeError);
    expect(() => parseScrape('')).toThrow(MalformedScrapeError);
  });

  it('ignores a version label that is not a plain version', () => {
    const text = `drain_sidecar_drained 0\ndrain_sidecar_ghost_version_info{version="<script>"} 1\n`;
    expect(parseScrape(text).reportedVersion).toBeNull();
  });
});

describe('deriveReading', () => {
  it('steady: one undrained colour answers', () => {
    expect(deriveReading([scrape(false, '6.55.0', true)])).toEqual({
      health: 'healthy',
      reportedVersion: '6.55.0',
      versionMatch: true,
    });
  });

  it('overlap: the retiring drained colour is never read, whichever is listed first', () => {
    const retiring = scrape(true);
    const serving = scrape(false, '6.55.0', true);
    for (const order of [
      [retiring, serving],
      [serving, retiring],
    ]) {
      expect(deriveReading(order)).toEqual({
        health: 'healthy',
        reportedVersion: '6.55.0',
        versionMatch: true,
      });
    }
  });

  it('reverted: the undrained colour still on the old version is a dated mismatch', () => {
    expect(deriveReading([scrape(true), scrape(false, '6.54.0', false)])).toEqual({
      health: 'healthy',
      reportedVersion: '6.54.0',
      versionMatch: false,
    });
  });

  it('an undrained colour that reports no version is unhealthy', () => {
    expect(deriveReading([scrape(false)])).toEqual({
      health: 'unhealthy',
      reportedVersion: null,
      versionMatch: null,
    });
  });

  it('says nothing with no scrape, no undrained colour, or two undrained colours', () => {
    const unknown = { health: 'unknown', reportedVersion: null, versionMatch: null };
    expect(deriveReading([])).toEqual(unknown);
    expect(deriveReading([scrape(true), scrape(true)])).toEqual(unknown);
    expect(deriveReading([scrape(false, '6.55.0', true), scrape(false, '6.54.0', false)])).toEqual(
      unknown
    );
  });
});
