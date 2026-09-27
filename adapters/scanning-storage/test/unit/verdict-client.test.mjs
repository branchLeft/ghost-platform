import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { VerdictClient, FakeVerdictClient } = require('../../src/verdict-client.js');

describe('VerdictClient', () => {
  it('the base interface throws, so a caller cannot mistake it for an implementation', async () => {
    await expect(new VerdictClient().getVerdict('digest')).rejects.toThrow(/not implemented/);
  });
});

describe('FakeVerdictClient', () => {
  it('returns no-known-match for a digest it was not told to refuse', async () => {
    const client = new FakeVerdictClient();
    const verdict = await client.getVerdict('unknown-digest');
    expect(verdict.classification).toBe('no-known-match');
    expect(verdict.evidence).toBe('unknown-digest');
  });

  it('returns the configured classification for a digest it was told to refuse', async () => {
    const client = new FakeVerdictClient({
      refuse: new Map([['bad-digest', { classification: 'csam', matchType: 'exact' }]]),
    });
    const verdict = await client.getVerdict('bad-digest');
    expect(verdict.classification).toBe('csam');
    expect(verdict.matchType).toBe('exact');
    expect(verdict.evidence).toBe('bad-digest');
  });

  it('accepts a plain object as well as a Map for refuse', async () => {
    const client = new FakeVerdictClient({
      refuse: { 'bad-digest': { classification: 'test', matchType: 'near' } },
    });
    const verdict = await client.getVerdict('bad-digest');
    expect(verdict.classification).toBe('test');
  });

  it('never returns unavailable: the in-process fake has no timeout or channel outage to model', async () => {
    const client = new FakeVerdictClient();
    const verdict = await client.getVerdict('anything');
    expect(verdict.classification).not.toBe('unavailable');
  });
});
