import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  VerdictClient,
  FakeVerdictClient,
  UnconfiguredVerdictClient,
} = require('../../src/verdict-client.js');

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

  it('never returns unavailable for a digest not named in `unavailable`', async () => {
    const client = new FakeVerdictClient();
    const verdict = await client.getVerdict('anything');
    expect(verdict.classification).not.toBe('unavailable');
  });

  describe('the hold branch: simulating a channel with no answer yet', () => {
    it('returns unavailable for a digest named in `unavailable`', async () => {
      const client = new FakeVerdictClient({ unavailable: ['held-digest'] });
      const verdict = await client.getVerdict('held-digest');
      expect(verdict.classification).toBe('unavailable');
      expect(verdict.evidence).toBe('held-digest');
    });

    it('deliverVerdict makes a later call answer definitively, in-process', async () => {
      const client = new FakeVerdictClient({ unavailable: ['held-digest'] });
      expect((await client.getVerdict('held-digest')).classification).toBe('unavailable');

      client.deliverVerdict('held-digest', { classification: 'no-known-match' });

      const resolved = await client.getVerdict('held-digest');
      expect(resolved.classification).toBe('no-known-match');
      expect(resolved.evidence).toBe('held-digest');
    });

    it('a resolvePath file answers a held digest without deliverVerdict, for a driver in a different process', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdict-resolve-'));
      try {
        const client = new FakeVerdictClient({ unavailable: ['held-digest'], resolvePath: dir });
        expect((await client.getVerdict('held-digest')).classification).toBe('unavailable');

        await fs.writeFile(
          path.join(dir, 'held-digest.json'),
          JSON.stringify({ classification: 'harmful-abusive-material', matchType: 'exact' })
        );

        const resolved = await client.getVerdict('held-digest');
        expect(resolved.classification).toBe('harmful-abusive-material');
        expect(resolved.matchType).toBe('exact');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('a missing or malformed resolvePath file reads as still unavailable, never throws', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdict-resolve-'));
      try {
        const client = new FakeVerdictClient({ unavailable: ['held-digest'], resolvePath: dir });
        expect((await client.getVerdict('held-digest')).classification).toBe('unavailable');

        await fs.writeFile(path.join(dir, 'held-digest.json'), 'not json');
        expect((await client.getVerdict('held-digest')).classification).toBe('unavailable');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('UnconfiguredVerdictClient', () => {
  it('never vouches for a digest: every answer is unavailable, never no-known-match', async () => {
    const client = new UnconfiguredVerdictClient();
    for (const digest of ['a', 'b', 'c']) {
      const verdict = await client.getVerdict(digest);
      expect(verdict.classification).toBe('unavailable');
      expect(verdict.evidence).toBe(digest);
      expect(verdict.source).toBe('unconfigured-verdict-source');
    }
  });

  it('carries a caller-supplied source name', async () => {
    const verdict = await new UnconfiguredVerdictClient({ source: 'x' }).getVerdict('d');
    expect(verdict.source).toBe('x');
  });
});
