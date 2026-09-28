import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createPdqKnownMaterialCheck, DEFAULT_TIMEOUT_MS } = require('../../src/checks.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');

const computeDigest = (buffer) => buffer.toString('hex');

describe('createPdqKnownMaterialCheck', () => {
  it('declares kind media and blocking true', () => {
    const check = createPdqKnownMaterialCheck(new FakeVerdictClient(), { computeDigest });
    expect(check.kind).toBe('media');
    expect(check.blocking).toBe(true);
  });

  it('requires a computeDigest function', () => {
    expect(() => createPdqKnownMaterialCheck(new FakeVerdictClient(), {})).toThrow(/computeDigest/);
  });

  it('runs the verdict client against the hash of the subject bytes', async () => {
    const digest = computeDigest(Buffer.from('bad'));
    const client = new FakeVerdictClient({
      refuse: new Map([[digest, { classification: 'csam' }]]),
    });
    const check = createPdqKnownMaterialCheck(client, { computeDigest });
    const verdict = await check.run({ buffer: Buffer.from('bad') });
    expect(verdict.classification).toBe('csam');
    expect(verdict.evidence).toBe(digest);
  });

  it('never throws: a verdict client that rejects resolves to an unavailable verdict', async () => {
    const client = {
      async getVerdict() {
        throw new Error('channel unreachable');
      },
    };
    const check = createPdqKnownMaterialCheck(client, { computeDigest });
    const verdict = await check.run({ buffer: Buffer.from('anything') });
    expect(verdict.classification).toBe('unavailable');
  });

  it('never throws: a verdict client slower than the budget resolves to unavailable instead of hanging', async () => {
    const client = { getVerdict: () => new Promise(() => {}) };
    const check = createPdqKnownMaterialCheck(client, { computeDigest, timeoutMs: 10 });
    const verdict = await check.run({ buffer: Buffer.from('anything') });
    expect(verdict.classification).toBe('unavailable');
  });

  it('defaults the timeout to a positive number of milliseconds', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
