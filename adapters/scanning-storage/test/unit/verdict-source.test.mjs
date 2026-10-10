import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  IN_PROCESS_FAKE,
  SCANNER_UNCONFIGURED,
  parseJsonConfig,
  resolveVerdictSource,
} = require('../../src/verdict-source.js');
const { FakeVerdictClient, UnconfiguredVerdictClient } = require('../../src/verdict-client.js');

describe('resolveVerdictSource', () => {
  it('is unconfigured by default, with no config at all', () => {
    const source = resolveVerdictSource();
    expect(source.kind).toBe('unconfigured');
    expect(source.verdictClient).toBeInstanceOf(UnconfiguredVerdictClient);
    expect(source.refuseUploadsReason).toBe(SCANNER_UNCONFIGURED);
  });

  it('is unconfigured when only the fake seed keys are present', () => {
    const source = resolveVerdictSource({
      refuse: { d: { classification: 'csam' } },
      unavailable: ['x'],
      resolvePath: '/tmp/x',
    });
    expect(source.refuseUploadsReason).toBe(SCANNER_UNCONFIGURED);
    expect(source.verdictClient).not.toBeInstanceOf(FakeVerdictClient);
  });

  it.each([undefined, null, '', 'true', true, 1, 'IN-PROCESS-FAKE', ' in-process-fake', 'fake'])(
    'treats verdictSource %j as unconfigured',
    (verdictSource) => {
      expect(resolveVerdictSource({ verdictSource }).refuseUploadsReason).toBe(
        SCANNER_UNCONFIGURED
      );
    }
  );

  it('selects the fake only on the exact flag, and then refuses nothing', () => {
    const source = resolveVerdictSource({ verdictSource: IN_PROCESS_FAKE });
    expect(source.kind).toBe(IN_PROCESS_FAKE);
    expect(source.verdictClient).toBeInstanceOf(FakeVerdictClient);
    expect(source.refuseUploadsReason).toBeNull();
  });

  it('seeds the fake from JSON strings and from plain values', async () => {
    const source = resolveVerdictSource({
      verdictSource: IN_PROCESS_FAKE,
      refuse: '{"d1":{"classification":"csam"}}',
      unavailable: ['d2'],
      resolvePath: '/tmp/resolve',
    });
    await expect(source.verdictClient.getVerdict('d1')).resolves.toMatchObject({
      classification: 'csam',
    });
    await expect(source.verdictClient.getVerdict('d2')).resolves.toMatchObject({
      classification: 'unavailable',
    });
    expect(source.verdictClient.resolvePath).toBe('/tmp/resolve');
  });
});

describe('parseJsonConfig', () => {
  it('falls back on unparseable JSON and on a missing value', () => {
    expect(parseJsonConfig('{not json', { a: 1 })).toEqual({ a: 1 });
    expect(parseJsonConfig(undefined, [])).toEqual([]);
    expect(parseJsonConfig(null, [])).toEqual([]);
  });

  it('passes a non-string value straight through', () => {
    expect(parseJsonConfig({ k: 1 }, {})).toEqual({ k: 1 });
  });
});
