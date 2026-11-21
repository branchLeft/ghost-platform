import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createPdqKnownMaterialCheck, DEFAULT_TIMEOUT_MS } = require('../../src/checks.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');

const computeDigest = (buffer) => buffer.toString('hex');
// The key the hash source is asked about is not the digest: a stand-in that
// differs from it shows which of the two each part uses.
const keyOf = (buffer) => `key-${buffer.toString('hex')}`;
const computeVerdictKey = async (buffer) => ({ hash: keyOf(buffer), reason: null });

describe('createPdqKnownMaterialCheck', () => {
  it('declares kind media and blocking true', () => {
    const check = createPdqKnownMaterialCheck(new FakeVerdictClient(), {
      computeDigest,
      computeVerdictKey,
    });
    expect(check.kind).toBe('media');
    expect(check.blocking).toBe(true);
  });

  it('requires a computeDigest function', () => {
    expect(() => createPdqKnownMaterialCheck(new FakeVerdictClient(), {})).toThrow(/computeDigest/);
  });

  it('runs the verdict client against the hash of the subject bytes', async () => {
    const digest = computeDigest(Buffer.from('bad'));
    const client = new FakeVerdictClient({
      refuse: new Map([[keyOf(Buffer.from('bad')), { classification: 'csam' }]]),
    });
    const check = createPdqKnownMaterialCheck(client, { computeDigest, computeVerdictKey });
    const verdict = await check.run({ buffer: Buffer.from('bad') });
    expect(verdict.classification).toBe('csam');
    expect(verdict.evidence).toBe(digest);
  });

  it('asks the hash source about the verdict key and never about the content digest', async () => {
    const asked = [];
    const client = {
      async getVerdict(key) {
        asked.push(key);
        return { classification: 'clean', source: 'fake' };
      },
    };
    const check = createPdqKnownMaterialCheck(client, { computeDigest, computeVerdictKey });
    await check.run({ buffer: Buffer.from('picture') });
    expect(asked).toEqual([keyOf(Buffer.from('picture'))]);
    expect(asked).not.toContain(computeDigest(Buffer.from('picture')));
  });

  it('holds bytes that have no hash: unavailable, the hash source is not asked, the evidence is the digest', async () => {
    const asked = [];
    const client = {
      async getVerdict(key) {
        asked.push(key);
        return { classification: 'clean', source: 'fake' };
      },
    };
    const check = createPdqKnownMaterialCheck(client, {
      computeDigest,
      computeVerdictKey: async () => ({ hash: null, reason: 'not-an-image' }),
    });
    const verdict = await check.run({ buffer: Buffer.from('not a picture') });
    expect(verdict.classification).toBe('unavailable');
    expect(verdict.source).toBe('no-perceptual-hash');
    expect(verdict.evidence).toBe(computeDigest(Buffer.from('not a picture')));
    expect(asked).toEqual([]);
  });

  it('treats a key function that throws, or answers with no usable hash, as no hash', async () => {
    const client = { getVerdict: async () => ({ classification: 'clean', source: 'fake' }) };
    for (const bad of [
      async () => {
        throw new Error('decoder fell over');
      },
      async () => undefined,
      async () => ({ hash: '' }),
      async () => ({ hash: 42 }),
    ]) {
      const check = createPdqKnownMaterialCheck(client, { computeDigest, computeVerdictKey: bad });
      const verdict = await check.run({ buffer: Buffer.from('x') });
      expect(verdict.classification).toBe('unavailable');
    }
  });

  it('requires a computeVerdictKey function', () => {
    expect(() => createPdqKnownMaterialCheck(new FakeVerdictClient(), { computeDigest })).toThrow(
      /computeVerdictKey/
    );
  });

  it('never throws: a verdict client that rejects resolves to an unavailable verdict', async () => {
    const client = {
      async getVerdict() {
        throw new Error('channel unreachable');
      },
    };
    const check = createPdqKnownMaterialCheck(client, { computeDigest, computeVerdictKey });
    const verdict = await check.run({ buffer: Buffer.from('anything') });
    expect(verdict.classification).toBe('unavailable');
  });

  it('never throws: a verdict client slower than the budget resolves to unavailable instead of hanging', async () => {
    const client = { getVerdict: () => new Promise(() => {}) };
    const check = createPdqKnownMaterialCheck(client, {
      computeDigest,
      computeVerdictKey,
      timeoutMs: 10,
    });
    const verdict = await check.run({ buffer: Buffer.from('anything') });
    expect(verdict.classification).toBe('unavailable');
  });

  it('defaults the timeout to a positive number of milliseconds', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
